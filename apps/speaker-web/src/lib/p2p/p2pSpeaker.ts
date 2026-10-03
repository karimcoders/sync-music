import Peer, { DataConnection } from 'peerjs';

import { ClockSync, DriftController, projectPosition } from '@sync-music/sync-engine';
import { SILENT_WAV, type UiState } from '../client';
import { P2PMessage, PEER_OPTIONS } from './messages';

/**
 * Direct-mode speaker.
 *
 * Identical playback discipline to the server mode — NTP-style offset
 * estimation, start times scheduled on the authority's clock, the same
 * ignore / rate-nudge / seek drift policy — except the authority is the host's
 * browser and the audio arrives over the data channel instead of from a CDN.
 */
export class P2PSpeakerClient {
  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private clock = new ClockSync();
  private drift = new DriftController();
  private audio: HTMLAudioElement | null = null;
  private audioEnabled = false;

  private transportPlaying = false;
  private basePosition = 0;
  private baseHostTime = 0;
  private trackId: string | null = null;
  private objectUrl: string | null = null;
  private timers: number[] = [];
  private playTimer: number | null = null;
  /** last clock offset we aligned playback against */
  private alignedOffset = 0;
  private closed = false;
  private retry = 0;

  state: UiState = {
    conn: 'disconnected', phase: 'DISCONNECTED', sessionId: null, sessionName: '', speakerName: '',
    hostOnline: false, trackTitle: '', trackArtist: '', position: 0, duration: 0, playing: false,
    muted: false, volume: 1, latencyMs: 0, driftMs: 0, clockSynced: false, bufferedPct: 0,
    error: null, info: null,
  };

  constructor(private roomId: string, private onChange: (s: UiState) => void) {}

  /** diagnostics for tools/p2p-e2e.mjs */
  get debug() {
    return {
      offset: (this.clock as any).offset, rtt: (this.clock as any).rtt,
      synced: this.clock.synced, base: this.basePosition, baseAt: this.baseHostTime,
      target: this.targetPosition(), now: this.clock.now(),
    };
  }

  private set(p: Partial<UiState>) { this.state = { ...this.state, ...p }; this.onChange(this.state); }

  /** Same entry point the server-mode client exposes; there is nothing to list. */
  async autoConnect() { this.connect(); return []; }

  connect() {
    this.closed = false;
    this.set({ conn: 'connecting', phase: 'CONNECTING', info: 'Connecting directly to the host…' });
    const peer = new Peer(PEER_OPTIONS);
    this.peer = peer;
    peer.on('open', () => this.dial());
    peer.on('error', (e: any) => {
      if (e?.type === 'peer-unavailable') {
        this.set({ error: 'That host is not online. Ask them to open the host page again.', conn: 'disconnected', phase: 'DISCONNECTED' });
      } else {
        this.set({ error: 'Could not reach the connection broker.' });
      }
      this.scheduleReconnect();
    });
  }

  private dial() {
    const conn = this.peer!.connect(this.roomId, { reliable: true });
    this.conn = conn;

    // WebRTC can fail silently: if no path is found the channel simply never
    // opens. Say so instead of spinning forever.
    const watchdog = window.setTimeout(() => {
      if (!conn.open) {
        this.set({
          error: 'Could not reach the host. Both phones need internet, and the host tab must '
            + 'stay open. If one of you is on a restricted network, try the same Wi-Fi or '
            + 'mobile hotspot.',
        });
      }
    }, 12000);
    this.timers.push(watchdog);

    conn.on('open', () => {
      window.clearTimeout(watchdog);
      this.retry = 0;
      this.set({ conn: 'connected', sessionId: this.roomId, error: null, info: null,
        phase: this.audioEnabled ? 'AUDIO_READY' : 'AUDIO_DISABLED', hostOnline: true });
      this.send({ type: 'HELLO', deviceId: deviceId() });
      // A data channel is much jitterier than a WebSocket right after it opens,
      // and a bad offset here shows up directly as phones being apart. So we
      // probe hard for the first few seconds and keep a steady 1 Hz afterwards;
      // ClockSync keeps only the lowest-RTT third of the samples.
      for (let i = 0; i < 10; i++) {
        this.timers.push(window.setTimeout(() => this.ping(), i * 150));
      }
      this.timers.push(window.setInterval(() => this.ping(), 1000));
      this.startReporting();
    });

    conn.on('data', (d) => void this.handle(d as P2PMessage));
    conn.on('close', () => { this.set({ conn: 'reconnecting', hostOnline: false }); this.scheduleReconnect(); });
    conn.on('error', () => { this.set({ conn: 'reconnecting', hostOnline: false }); this.scheduleReconnect(); });
  }

  private scheduleReconnect() {
    if (this.closed) return;
    this.retry++;
    const wait = Math.min(15000, 600 * 2 ** Math.min(this.retry, 5));
    this.timers.push(window.setTimeout(() => {
      if (this.closed) return;
      try { this.peer?.destroy(); } catch {}
      this.connect();
    }, wait));
  }

  private send(m: P2PMessage) { try { if (this.conn?.open) this.conn.send(m); } catch {} }
  private ping() { this.send({ type: 'PING', t1: Date.now() }); }

  /* ------------------------------- events ------------------------------ */

  private async handle(m: P2PMessage) {
    switch (m.type) {
      case 'WELCOME':
        this.set({ speakerName: m.name, sessionName: m.sessionName, hostOnline: true });
        break;

      case 'PONG': {
        const t4 = Date.now();
        this.clock.addSample(m.t1, m.t2, m.t3, t4);
        // A data channel's first seconds are very jittery: the offset estimate
        // can be hundreds of ms out, and anything we started during that window
        // began at the wrong moment. When the estimate materially improves,
        // realign playback once instead of waiting for the slow drift loop.
        if (Math.abs(this.clock.offset - this.alignedOffset) > 30) {
          this.alignedOffset = this.clock.offset;
          this.realign();
        }
        this.set({ latencyMs: Math.round(this.clock.latencyMs), clockSynced: this.clock.synced });
        break;
      }

      case 'PING':
        // the host measures us too
        this.send({ type: 'PONG', t1: m.t1, t2: Date.now(), t3: Date.now() });
        break;

      case 'TRACK': {
        if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
        const blob = new Blob([m.bytes], { type: m.mime || 'audio/mpeg' });
        this.objectUrl = URL.createObjectURL(blob);
        this.trackId = m.trackId;
        this.set({ trackTitle: m.title, trackArtist: '', info: null });
        if (this.audioEnabled) this.loadAudio();
        this.send({ type: 'TRACK_READY', trackId: m.trackId });
        break;
      }

      case 'PLAY':
        this.transportPlaying = true;
        this.basePosition = m.position;
        this.baseHostTime = m.startAt;
        this.set({ playing: true });
        if (!this.audioEnabled) { this.set({ phase: 'AUDIO_DISABLED' }); break; }
        this.loadAudio();
        this.schedulePlay(m.position, m.startAt);
        break;

      case 'PAUSE': {
        this.transportPlaying = false;
        this.basePosition = m.position;
        this.baseHostTime = this.clock.now();
        if (this.playTimer) window.clearTimeout(this.playTimer);
        const a = this.audio;
        if (a) { a.pause(); try { a.currentTime = m.position; } catch {} }
        this.set({ playing: false, phase: this.audioEnabled ? 'AUDIO_READY' : 'AUDIO_DISABLED' });
        break;
      }

      case 'STOP':
        this.transportPlaying = false;
        this.basePosition = 0;
        if (this.playTimer) window.clearTimeout(this.playTimer);
        if (this.audio) { this.audio.pause(); try { this.audio.currentTime = 0; } catch {} }
        this.set({ playing: false, position: 0, phase: this.audioEnabled ? 'AUDIO_READY' : 'AUDIO_DISABLED' });
        break;

      case 'SEEK': {
        this.basePosition = m.position;
        this.baseHostTime = m.applyAt;
        const wait = Math.max(0, m.applyAt - this.clock.now());
        window.setTimeout(() => {
          const a = this.audio;
          if (!a) return;
          try { a.currentTime = m.position; } catch {}
          if (this.transportPlaying) void a.play().catch(() => this.set({ phase: 'AUDIO_DISABLED' }));
        }, wait);
        break;
      }

      case 'RESYNC':
        this.transportPlaying = m.playing;
        this.basePosition = m.position;
        this.baseHostTime = m.atHostTime;
        this.drift.reset();
        this.set({ playing: m.playing });
        if (this.audioEnabled) this.catchUp();
        break;

      case 'VOLUME':
        this.set({ volume: m.volume });
        this.applyVolume();
        break;

      case 'RENAME':
        this.set({ speakerName: m.name });
        break;
    }
  }

  /* ------------------------------- audio -------------------------------- */

  async enableSpeaker(): Promise<boolean> {
    if (!this.audio) {
      const a = new Audio();
      a.preload = 'auto';
      (a as any).playsInline = true;
      a.addEventListener('loadedmetadata', () => this.set({ duration: a.duration || 0 }));
      a.addEventListener('progress', () => this.updateBuffered());
      this.audio = a;
      (window as any).__syncAudio = a; // diagnostics / e2e only
    }
    try {
      this.audio.muted = true;
      this.audio.src = SILENT_WAV;
      await this.audio.play();
      this.audio.pause();
      this.audio.currentTime = 0;
      this.audio.muted = false;
      this.audioEnabled = true;
      this.set({ phase: 'AUDIO_READY', error: null, info: null });
      this.loadAudio();
      if (this.transportPlaying) this.catchUp();
      return true;
    } catch {
      this.audioEnabled = false;
      this.set({ phase: 'AUDIO_DISABLED', error: 'Your browser blocked audio. Tap Enable Speaker.' });
      return false;
    }
  }

  get isAudioEnabled() { return this.audioEnabled; }

  private loadAudio() {
    const a = this.audio;
    if (!a || !this.objectUrl || !this.trackId) return;
    if (a.dataset.audioId === this.trackId) return;
    a.src = this.objectUrl;
    a.dataset.audioId = this.trackId;
    a.load();
    this.applyVolume();
  }

  private applyVolume() { if (this.audio) this.audio.volume = this.state.muted ? 0 : this.state.volume; }

  private updateBuffered() {
    const a = this.audio;
    if (!a || !a.duration) return;
    const end = a.buffered.length ? a.buffered.end(a.buffered.length - 1) : 0;
    this.set({ bufferedPct: Math.min(100, (end / a.duration) * 100) });
  }

  private targetPosition() {
    return projectPosition(
      this.basePosition, this.baseHostTime, this.clock.now(), this.transportPlaying,
      this.state.duration || Infinity,
    );
  }

  /** Snap onto the timeline now (used when the clock estimate jumps). */
  private realign() {
    const a = this.audio;
    if (!a || !this.audioEnabled || !this.transportPlaying || a.paused) return;
    const target = this.targetPosition();
    if (Math.abs(a.currentTime - target) < 0.03) return;
    try { a.currentTime = target; } catch {}
    a.playbackRate = 1;
    this.drift.reset();
  }

  private schedulePlay(position: number, startAt: number) {
    const a = this.audio;
    if (!a) return;
    if (this.playTimer) window.clearTimeout(this.playTimer);
    this.set({ phase: 'SYNCING' });

    const arm = () => {
      const lead = startAt - this.clock.now();
      if (lead <= 0) { this.catchUp(); return; }
      try { a.currentTime = position; } catch {}
      this.playTimer = window.setTimeout(() => {
        const err = startAt - this.clock.now();
        try { a.currentTime = position - Math.min(0, err) / 1000; } catch {}
        void a.play()
          .then(() => {
            this.set({ phase: 'PLAYING', playing: true });
            // Slow decoders can begin hundreds of ms late, and a data channel's
            // clock keeps improving in the first seconds, so check twice.
            for (const delay of [400, 1500]) {
              window.setTimeout(() => {
                if (!this.transportPlaying || a.paused) return;
                const t = this.targetPosition();
                if (Math.abs(a.currentTime - t) > 0.08) { try { a.currentTime = t; } catch {} }
              }, delay);
            }
          })
          .catch(() => this.set({ phase: 'AUDIO_DISABLED', error: 'Your browser blocked audio. Tap Enable Speaker.' }));
      }, Math.max(0, lead - 5));
    };
    if (a.readyState >= 2) arm();
    else a.addEventListener('loadeddata', arm, { once: true });
  }

  /** Late join / resync — a start that is still in the future must be scheduled. */
  private catchUp() {
    const a = this.audio;
    if (!a || !this.audioEnabled) return;
    const untilStart = this.baseHostTime - this.clock.now();
    if (this.transportPlaying && untilStart > 20) { this.schedulePlay(this.basePosition, this.baseHostTime); return; }
    const target = this.targetPosition();
    try { a.currentTime = target; } catch {}
    if (this.transportPlaying) {
      void a.play()
        .then(() => this.set({ phase: 'PLAYING', playing: true }))
        .catch(() => this.set({ phase: 'AUDIO_DISABLED', error: 'Your browser blocked audio. Tap Enable Speaker.' }));
    }
  }

  private startReporting() {
    const report = () => {
      const a = this.audio;
      const buffered = a && a.buffered.length ? a.buffered.end(a.buffered.length - 1) - a.currentTime : 0;
      this.send({
        type: 'STATUS', position: a?.currentTime ?? 0, atHostTime: this.clock.now(),
        rate: a?.playbackRate ?? 1, playing: !!a && !a.paused, buffered: Math.max(0, buffered),
        clockRtt: Math.round(this.clock.rtt), clockSynced: this.clock.synced,
        clockSamples: this.clock.sampleCount,
      });
      this.timers.push(window.setTimeout(report, 600));
    };
    report();
    this.timers.push(window.setInterval(() => this.correctDrift(), 1000));
  }

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

  disconnect() {
    this.closed = true;
    this.timers.forEach((t) => { window.clearTimeout(t); window.clearInterval(t); });
    if (this.playTimer) window.clearTimeout(this.playTimer);
    try { this.conn?.close(); } catch {}
    try { this.peer?.destroy(); } catch {}
    this.audio?.pause();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.set({ conn: 'disconnected', phase: 'DISCONNECTED' });
  }
}

function deviceId(): string {
  const KEY = 'sync-music.deviceId';
  let v = localStorage.getItem(KEY);
  if (!v) {
    v = (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)) + '-' + Date.now().toString(36);
    localStorage.setItem(KEY, v);
  }
  return v;
}
