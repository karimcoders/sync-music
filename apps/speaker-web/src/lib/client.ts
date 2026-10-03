import {
  ClientMessage, PlaybackState, ServerMessage, SYNC, safeParse, statusIntervalMs,
} from '@sync-music/protocol';
import { ClockSync, DriftController, projectPosition } from '@sync-music/sync-engine';
import { absoluteAudioUrl, apiUrl, backendOrigin, wsUrl } from './backend';

export type ConnStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
export type SpeakerPhase =
  | 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'AUDIO_DISABLED'
  | 'AUDIO_READY' | 'SYNCING' | 'PLAYING';

export interface UiState {
  conn: ConnStatus;
  phase: SpeakerPhase;
  sessionId: string | null;
  sessionName: string;
  speakerName: string;
  hostOnline: boolean;
  trackTitle: string;
  trackArtist: string;
  position: number;
  duration: number;
  playing: boolean;
  muted: boolean;
  volume: number;
  latencyMs: number;
  driftMs: number;
  clockSynced: boolean;
  bufferedPct: number;
  error: string | null;
  info: string | null;
}

const DEVICE_KEY = 'sync-music.deviceId';
const TOKEN_KEY = 'sync-music.speakerToken';
const LAST_SESSION_KEY = 'sync-music.lastSession';

function deviceId(): string {
  let v = localStorage.getItem(DEVICE_KEY);
  if (!v) {
    v = (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)) + '-' + Date.now().toString(36);
    localStorage.setItem(DEVICE_KEY, v);
  }
  return v;
}

/**
 * The speaker runtime.
 *  - one <audio> element, created on the user's "Enable Speaker" gesture
 *  - NTP-style clock sync against the server
 *  - all playback is scheduled against absolute server timestamps
 *  - drift is corrected softly (playbackRate) or hard (seek) per the engine
 *  - auto-reconnect with identity reclaim, no manual reload ever required
 */
export class SpeakerClient {
  private ws: WebSocket | null = null;
  private clock = new ClockSync();
  private drift = new DriftController();
  private audio: HTMLAudioElement | null = null;
  private audioEnabled = false;
  private retry = 0;
  private reconnectTimer: number | null = null;
  private clockTimer: number | null = null;
  private statusTimer: number | null = null;
  private driftTimer: number | null = null;
  private playTimer: number | null = null;
  private closedByUs = false;
  private speakerCount = 1;
  private currentAudioId: string | null = null;
  private currentUrl: string | null = null;
  private transportPlaying = false;
  private basePosition = 0;
  private baseServerTime = 0;

  state: UiState = {
    conn: 'disconnected', phase: 'DISCONNECTED', sessionId: null, sessionName: '',
    speakerName: '', hostOnline: false, trackTitle: '', trackArtist: '', position: 0,
    duration: 0, playing: false, muted: false, volume: 1, latencyMs: 0, driftMs: 0,
    clockSynced: false, bufferedPct: 0, error: null, info: null,
  };

  constructor(private onChange: (s: UiState) => void) {}

  private set(patch: Partial<UiState>) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  /* --------------------------- discovery --------------------------- */

  get backend() { return backendOrigin || location.origin; }

  async discover() {
    const r = await fetch(apiUrl('/api/session/active'), { cache: 'no-store', mode: 'cors' });
    if (!r.ok) throw new Error('discovery failed');
    return (await r.json()) as {
      sessions: { sessionId: string; name: string; speakerCount: number; hostOnline: boolean }[];
      autoAttach: string | null;
    };
  }

  /* --------------------------- connection -------------------------- */

  connect(sessionId: string) {
    this.closedByUs = false;
    localStorage.setItem(LAST_SESSION_KEY, sessionId);
    this.set({ sessionId, conn: this.retry ? 'reconnecting' : 'connecting', phase: 'CONNECTING', error: null });
    let ws: WebSocket;
    try { ws = new WebSocket(wsUrl()); } catch { return this.scheduleReconnect(); }
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.set({ conn: 'connected', phase: 'CONNECTED', error: null });
      this.send({
        type: 'SPEAKER_JOIN',
        sessionId,
        deviceId: deviceId(),
        speakerToken: localStorage.getItem(TOKEN_KEY) ?? undefined,
      });
      this.startClockSync();
      this.startStatusReports();
    };
    ws.onmessage = (ev) => {
      const msg = safeParse<ServerMessage>(String(ev.data));
      if (msg) this.handle(msg);
    };
    ws.onclose = () => {
      this.stopTimers();
      if (this.closedByUs) { this.set({ conn: 'disconnected', phase: 'DISCONNECTED' }); return; }
      // keep playing whatever is buffered; just show that we are reconnecting
      this.set({ conn: 'reconnecting', info: 'Connection lost. Reconnecting…' });
      this.scheduleReconnect();
    };
    ws.onerror = () => { /* surfaced through onclose */ };
  }

  disconnect() {
    this.closedByUs = true;
    this.stopTimers();
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this.audio?.pause();
    this.set({ conn: 'disconnected', phase: this.audioEnabled ? 'AUDIO_READY' : 'DISCONNECTED', playing: false });
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.retry += 1;
    const backoff = Math.min(15000, 500 * 2 ** Math.min(this.retry, 5)) + Math.random() * 400;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      const sid = this.state.sessionId;
      if (!sid) { void this.autoConnect(); return; }
      this.connect(sid);
    }, backoff);
  }

  /**
   * Server-side discovery; auto-attach when exactly one host session exists.
   * Throws when the backend is unreachable so the UI can offer the server
   * address field instead of spinning forever.
   */
  async autoConnect() {
    try {
      const { sessions, autoAttach } = await this.discover();
      this.set({ error: null });
      // A refresh/crash should not cost the user a tap: if we were attached to
      // a session that is still alive, rejoin it silently.
      const last = localStorage.getItem(LAST_SESSION_KEY);
      const stillThere = last && sessions.some((x: any) => x.sessionId === last) ? last : null;
      if (stillThere) this.connect(stillThere);
      else if (autoAttach) this.connect(autoAttach);
      return sessions;
    } catch (e) {
      this.set({ error: 'Unable to reach the server. Retrying…' });
      throw e;
    }
  }

  private send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /* --------------------------- clock sync -------------------------- */

  private pending = new Map<number, number>();

  private probeClock() {
    const t1 = Date.now();
    this.pending.set(t1, t1);
    this.send({ type: 'CLOCK_SYNC', clientTime: t1 });
  }

  private startClockSync() {
    for (let i = 0; i < SYNC.CLOCK_BURST; i++) {
      window.setTimeout(() => this.probeClock(), i * SYNC.CLOCK_BURST_INTERVAL_MS);
    }
    this.clockTimer = window.setInterval(() => this.probeClock(), SYNC.CLOCK_REFRESH_MS);
  }

  private startStatusReports() {
    const schedule = () => {
      const iv = statusIntervalMs(this.speakerCount);
      this.statusTimer = window.setTimeout(() => {
        const a = this.audio;
        const state: PlaybackState = !a ? 'idle' : a.paused ? 'paused' : 'playing';
        const buffered = a && a.buffered.length ? a.buffered.end(a.buffered.length - 1) - a.currentTime : 0;
        this.send({ type: 'PLAYBACK_STATUS', position: a?.currentTime ?? 0, state, buffered: Math.max(0, buffered) });
        schedule();
      }, iv);
    };
    schedule();
    this.driftTimer = window.setInterval(() => this.correctDrift(), 1000);
  }

  private stopTimers() {
    for (const t of [this.clockTimer, this.driftTimer]) if (t) window.clearInterval(t);
    for (const t of [this.statusTimer, this.playTimer]) if (t) window.clearTimeout(t);
    this.clockTimer = this.driftTimer = this.statusTimer = this.playTimer = null;
  }

  /* ------------------------- audio activation ---------------------- */

  /** MUST be called from a real user gesture (Android/Chrome autoplay policy). */
  async enableSpeaker(): Promise<boolean> {
    if (!this.audio) {
      const a = new Audio();
      a.preload = 'auto';
      a.crossOrigin = 'anonymous';
      (a as any).playsInline = true;
      a.loop = false;
      a.addEventListener('error', () => this.set({ error: 'Audio could not be loaded. Tap Retry.' }));
      a.addEventListener('progress', () => this.updateBuffered());
      a.addEventListener('loadedmetadata', () => this.set({ duration: a.duration || 0 }));
      this.audio = a;
      (window as any).__syncAudio = a; // diagnostics / e2e only
    }
    try {
      // unlock: play a muted silent buffer within the gesture
      this.audio.muted = true;
      this.audio.src = SILENT_WAV;
      await this.audio.play();
      this.audio.pause();
      this.audio.currentTime = 0;
      this.audio.muted = false;
      this.audioEnabled = true;
      this.set({ phase: 'AUDIO_READY', error: null, info: null });
      this.send({ type: 'SPEAKER_READY' });
      if (this.currentUrl) await this.loadAudio(this.currentUrl, this.currentAudioId!);
      // if playback is already running on the host, catch up immediately
      if (this.transportPlaying) this.catchUp();
      return true;
    } catch (e) {
      this.audioEnabled = false;
      this.set({ phase: 'AUDIO_DISABLED', error: 'Your browser blocked audio. Tap Enable Speaker.' });
      return false;
    }
  }

  get isAudioEnabled() { return this.audioEnabled; }

  private updateBuffered() {
    const a = this.audio;
    if (!a || !a.duration) return;
    const end = a.buffered.length ? a.buffered.end(a.buffered.length - 1) : 0;
    this.set({ bufferedPct: Math.min(100, (end / a.duration) * 100) });
  }

  /**
   * Fetch-and-cache the asset once (Cache API), then play from the cache.
   * Audio comes from storage/CDN, never from the host device.
   */
  private async loadAudio(url: string, audioId: string) {
    if (!this.audio) return;
    if (this.audio.dataset.audioId === audioId && this.audio.src) return;
    this.set({ phase: 'SYNCING', info: 'Loading track…' });
    let src = url;
    try {
      if ('caches' in window) {
        const cache = await caches.open('sync-music-audio-v1');
        let res = await cache.match(audioId);
        if (!res) {
          const net = await fetch(url, { mode: 'cors' });
          if (!net.ok) throw new Error(`HTTP ${net.status}`);
          await cache.put(audioId, net.clone());
          res = await cache.match(audioId);
        }
        if (res) src = URL.createObjectURL(await res.blob());
      }
    } catch {
      src = url; // streaming fallback with HTTP range requests
    }
    this.audio.src = src;
    this.audio.dataset.audioId = audioId;
    this.audio.load();
    this.set({ info: null });
  }

  /* --------------------------- server events ------------------------ */

  private async handle(msg: ServerMessage) {
    switch (msg.type) {
      case 'HELLO':
        // connectionId doubles as the speaker identity token after join
        if (msg.connectionId.includes('.')) localStorage.setItem(TOKEN_KEY, msg.connectionId);
        break;

      case 'SESSION_STATE': {
        const t = msg.transport;
        const track = t.playlist.find((p) => p.id === t.trackId) ?? null;
        this.speakerCount = msg.speakerCount;
        this.transportPlaying = t.state === 'playing';
        this.basePosition = t.position;
        this.baseServerTime = t.positionAtServerTime;
        this.currentAudioId = t.trackId;
        this.currentUrl = track ? absoluteAudioUrl(track.url) : null;
        this.set({
          sessionName: msg.sessionName,
          hostOnline: msg.hostOnline,
          speakerName: msg.you?.name ?? this.state.speakerName,
          trackTitle: track?.title ?? '',
          trackArtist: track?.artist ?? '',
          duration: track?.duration ?? this.state.duration,
          volume: t.volume,
          playing: t.state === 'playing',
          phase: this.audioEnabled ? (t.state === 'playing' ? 'SYNCING' : 'AUDIO_READY') : 'AUDIO_DISABLED',
          error: null,
        });
        if (this.audioEnabled && track) {
          await this.loadAudio(absoluteAudioUrl(track.url), track.id);
          this.applyVolume();
          if (t.state === 'playing') this.catchUp();
          else this.audio?.pause();
        }
        break;
      }

      case 'PLAYLIST': {
        const track = msg.playlist[msg.trackIndex];
        if (track) {
          this.set({ trackTitle: track.title, trackArtist: track.artist, duration: track.duration });
          this.currentAudioId = track.id;
          this.currentUrl = absoluteAudioUrl(track.url);
          if (this.audioEnabled) await this.loadAudio(this.currentUrl, track.id);
        }
        // ask for the authoritative transport that goes with this playlist
        this.send({ type: 'SPEAKER_READY' });
        break;
      }

      case 'TRACK_CHANGED':
        this.currentAudioId = msg.audioId;
        // we may not have this track's signed URL yet — request full state
        this.send({ type: 'SPEAKER_READY' });
        break;

      case 'SYNC_PLAY': {
        this.transportPlaying = true;
        this.basePosition = msg.position;
        this.baseServerTime = msg.startAt;
        this.set({ playing: true, volume: msg.volume });
        if (!this.audioEnabled) { this.set({ phase: 'AUDIO_DISABLED' }); break; }
        if (this.currentUrl && this.currentAudioId !== msg.audioId) {
          this.currentAudioId = msg.audioId;
        }
        if (this.audio?.dataset.audioId !== msg.audioId) {
          // we don't have this track loaded yet — ask for the authoritative
          // state (the reply carries the signed URL), then catch up.
          this.send({ type: 'SPEAKER_READY', audioId: msg.audioId });
        }
        this.schedulePlay(msg.position, msg.startAt);
        break;
      }

      case 'PAUSE': {
        this.transportPlaying = false;
        this.basePosition = msg.position;
        this.baseServerTime = msg.applyAt;
        const wait = Math.max(0, msg.applyAt - this.clock.now());
        window.setTimeout(() => {
          this.audio?.pause();
          if (this.audio) this.audio.currentTime = msg.position;
          this.set({ playing: false, phase: this.audioEnabled ? 'AUDIO_READY' : 'AUDIO_DISABLED' });
        }, wait);
        break;
      }

      case 'STOP':
        this.transportPlaying = false;
        this.basePosition = 0;
        if (this.audio) { this.audio.pause(); this.audio.currentTime = 0; }
        this.set({ playing: false, position: 0, phase: this.audioEnabled ? 'AUDIO_READY' : 'AUDIO_DISABLED' });
        break;

      case 'SEEK': {
        this.basePosition = msg.position;
        this.baseServerTime = msg.applyAt;
        this.transportPlaying = msg.playing;
        const wait = Math.max(0, msg.applyAt - this.clock.now());
        window.setTimeout(() => {
          if (!this.audio) return;
          this.audio.currentTime = msg.position;
          if (msg.playing) void this.audio.play().catch(() => this.set({ phase: 'AUDIO_DISABLED' }));
        }, wait);
        break;
      }

      case 'VOLUME':
        this.set({ volume: msg.volume });
        this.applyVolume();
        break;

      case 'MUTE':
        this.set({ muted: msg.muted });
        this.applyVolume();
        break;

      case 'RESYNC':
        this.basePosition = msg.position;
        this.baseServerTime = msg.atServerTime;
        this.transportPlaying = msg.playing;
        this.drift.reset();
        this.catchUp();
        break;

      case 'RENAMED':
        this.set({ speakerName: msg.name });
        break;

      case 'CLOCK_SYNC_REPLY': {
        const t4 = Date.now();
        const t1 = this.pending.get(msg.clientTime) ?? msg.clientTime;
        this.pending.delete(msg.clientTime);
        this.clock.addSample(t1, msg.serverReceiveTime, msg.serverSendTime, t4);
        this.set({ latencyMs: Math.round(this.clock.latencyMs), clockSynced: this.clock.synced });
        break;
      }

      case 'HOST_DISCONNECTED':
        this.set({ hostOnline: false, info: 'Host disconnected. Waiting for Host…' });
        break;

      case 'HOST_CONNECTED':
        this.set({ hostOnline: true, info: 'Host connected. Synchronizing…' });
        break;

      case 'SESSION_ENDED':
        this.set({ info: 'Host session ended.', playing: false, phase: 'DISCONNECTED', sessionId: null });
        this.audio?.pause();
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(LAST_SESSION_KEY);
        this.closedByUs = true;
        try { this.ws?.close(); } catch {}
        break;

      case 'ERROR':
        if (msg.code === 'SESSION_NOT_FOUND') {
          localStorage.removeItem(TOKEN_KEY);
          localStorage.removeItem(LAST_SESSION_KEY);
          this.set({ sessionId: null, error: msg.message, phase: 'DISCONNECTED' });
        } else {
          this.set({ error: msg.message });
        }
        break;
    }
  }

  private applyVolume() {
    if (!this.audio) return;
    this.audio.volume = this.state.muted ? 0 : this.state.volume;
  }

  /** Schedule playback against the synchronized server clock. */
  private schedulePlay(position: number, startAt: number) {
    if (!this.audio) return;
    if (this.playTimer) window.clearTimeout(this.playTimer);
    const a = this.audio;
    this.set({ phase: 'SYNCING' });

    const arm = () => {
      const lead = startAt - this.clock.now();
      if (lead <= 0) { this.catchUp(); return; }
      // seek a touch early so the decoder is primed at the exact start time
      try { a.currentTime = position; } catch {}
      this.playTimer = window.setTimeout(() => {
        const err = startAt - this.clock.now(); // residual ms (usually < 10)
        try { a.currentTime = position - Math.min(0, err) / 1000; } catch {}
        void a.play()
          .then(() => {
            this.set({ phase: 'PLAYING', playing: true });
            // Slow decoders can begin hundreds of ms late. Measure once, 400 ms
            // in, and snap if we are clearly off; the drift loop handles the rest.
            window.setTimeout(() => {
              if (!this.transportPlaying || a.paused) return;
              const target = this.targetPosition();
              if (Math.abs(a.currentTime - target) > 0.12) {
                try { a.currentTime = target; } catch {}
              }
            }, 400);
          })
          .catch(() => this.set({ phase: 'AUDIO_DISABLED', error: 'Your browser blocked audio. Tap Enable Speaker.' }));
      }, Math.max(0, lead - 5));
    };
    if (a.readyState >= 2) arm();
    else a.addEventListener('loadeddata', arm, { once: true });
  }

  /** Join an already-running timeline (late join / reconnect / resync). */
  private catchUp() {
    const a = this.audio;
    if (!a || !this.audioEnabled) return;
    const target = this.targetPosition();
    try { a.currentTime = target; } catch {}
    if (this.transportPlaying) {
      void a.play()
        .then(() => this.set({ phase: 'PLAYING', playing: true }))
        .catch(() => this.set({ phase: 'AUDIO_DISABLED', error: 'Your browser blocked audio. Tap Enable Speaker.' }));
    }
  }

  private targetPosition() {
    return projectPosition(
      this.basePosition, this.baseServerTime, this.clock.now(), this.transportPlaying, this.state.duration || Infinity,
    );
  }

  /** 1 Hz drift loop: ignore <50ms, rate-nudge 50–150ms, hard seek >150ms. */
  private correctDrift() {
    const a = this.audio;
    if (!a || !this.audioEnabled || !this.transportPlaying || a.paused || !this.clock.synced) {
      if (a) this.set({ position: a.currentTime });
      return;
    }
    const target = this.targetPosition();
    const c = this.drift.evaluate(a.currentTime, target);
    if (c.action === 'rate') a.playbackRate = c.rate;
    if (c.action === 'seek') { a.currentTime = c.targetPosition; a.playbackRate = 1; }
    this.set({ position: a.currentTime, driftMs: Math.round(c.driftMs), phase: 'PLAYING' });
    this.updateBuffered();
  }
}

/**
 * 0.25 s of real (non-empty) PCM silence. A zero-length WAV makes some Chrome
 * builds reject play(), which would wrongly look like a blocked-audio error.
 */
const SILENT_WAV_B64 =
  'UklGRsQPAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YaAPAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const SILENT_WAV = 'data:audio/wav;base64,' + SILENT_WAV_B64;
