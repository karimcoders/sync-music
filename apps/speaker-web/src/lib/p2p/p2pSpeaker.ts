import Peer, { DataConnection } from 'peerjs';
import { getTrack, putTrack, trackIds } from './speakerCache';
import { WebAudioPlayer } from './bufferPlayer';

import { ClockSync, DriftController, projectPosition } from '@sync-music/sync-engine';
import { SILENT_WAV, type UiState } from '../client';
import { P2PMessage, peerOptions, ROOM_SLOTS, FIXED_ROOM_ID, BROKERS } from './messages';

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
  /**
   * Two possible outputs, and we always prefer the first:
   *
   *  - `wa`: the decoded Web Audio player. Starts at an exact instant, never
   *    re-buffers, corrects by ramping rate. This is what killed the stutter.
   *  - `el`: a plain <audio> element, kept as the fallback for a format the
   *    browser will not decode and for a track still arriving.
   *
   * `this.audio` hands back whichever is live, with the same small API.
   */
  private el: HTMLAudioElement | null = null;
  private wa: WebAudioPlayer | null = null;
  private ctx: AudioContext | null = null;
  private blob: Blob | null = null;
  private decoding = false;
  private get audio(): any { return this.wa?.ready ? this.wa : this.el; }
  private audioEnabled = false;

  private transportPlaying = false;
  private basePosition = 0;
  private baseHostTime = 0;
  private trackId: string | null = null;      // track we are playing
  private haveTrack: string | null = null;    // track whose bytes we hold
  private objectUrl: string | null = null;
  /** last transport command applied — reported back so the host can repair us */
  private appliedSeq = 0;
  /** in-flight chunked download */
  private incoming: { trackId: string; title: string; mime: string; chunks: number; parts: (ArrayBuffer | undefined)[]; got: number } | null = null;
  private lastChunkAt = 0;
  private chaseTimer = 0;
  private timers: number[] = [];
  private playTimer: number | null = null;
  /** last clock offset we aligned playback against */
  private alignedOffset = 0;
  private closed = false;
  private retry = 0;
  private lastInbound = 0;
  private reconnectPending = false;

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

  private peers: Peer[] = [];

  connect() {
    this.closed = false;
    this.set({ conn: 'connecting', phase: 'CONNECTING', info: 'Looking for the host…' });
    // Register on EVERY broker at once. The host may have had to fall back to
    // a different one (the public one rate-limits and holds stale ids), and a
    // phone should not spend half a minute discovering that one by one.
    this.peers.forEach((p) => { try { p.destroy(); } catch {} });
    this.peers = BROKERS.map((_, b) => {
      const peer = new Peer(peerOptions(b));
      peer.on('open', () => this.dial(peer));
      // The host may open a live microphone; answer with no stream of our own.
      peer.on('call', (call) => {
        try { call.answer(); } catch { return; }
        call.on('stream', (stream) => this.playMic(stream));
        call.on('close', () => this.stopMic());
      });
      peer.on('error', (e: any) => {
        // One broker failing is not fatal while another may still answer, and
        // it must never disturb a connection we already have.
        if (this.conn?.open) return;
        if (e?.type === 'peer-unavailable') {
          this.set({
            conn: 'reconnecting', hostOnline: false,
            info: 'Host is not online right now — retrying…',
            error: this.retry > ROOM_SLOTS.length ? 'Nobody is hosting on this link right now. Ask them to open the host page.' : null,
          });
        }
      });
      return peer;
    });
    this.peer = this.peers[0];
    // If no broker produced a host within this window, move on to the next
    // wave of slots. (Each dial has its own, shorter hop timer as well.)
    this.timers.push(window.setTimeout(() => {
      if (!this.closed && !this.conn?.open) this.scheduleReconnect(300);
    }, 12000));
  }


  /**
   * The room is one shared link but a short list of broker slots (the public
   * broker can keep a name reserved after a host leaves). Walk the list until
   * a host answers — the phone never has to be told which slot is live.
   */

  private waveIndex = 0;

  private dial(peer: Peer) {
    // Dial every slot AT ONCE. Scanning them one by one took seconds before a
    // phone found the host; in parallel the first channel that opens wins and
    // the rest are dropped.
    // A phone should not open a dozen channels at once, so the slots are
    // dialled in small waves; the first one that answers wins and the rest
    // are dropped.
    const all = this.roomId === FIXED_ROOM_ID ? ROOM_SLOTS : [this.roomId];
    // Two at a time per broker: a phone negotiating a dozen ICE sessions at
    // once spends its CPU and radio on that instead of on smooth playback.
    // All four slots at once (there are only four), one broker at a time:
    // the live host answers within a second or two and the rest are dropped.
    const per = 4;
    const wave = this.waveIndex % Math.ceil(all.length / per);
    this.waveIndex++;
    const targets = all.length > per ? all.slice(wave * per, wave * per + per) : all;
    const tried = targets.map((t) => peer.connect(t, { reliable: true }));
    let won: DataConnection | null = null;

    const watchdog = window.setTimeout(() => {
      if (won || this.state.conn === 'connected') return;
      this.set({
        error: 'Could not reach the host. Both phones need internet, and the host tab must '
          + 'stay open. If one of you is on a restricted network, try the same Wi-Fi or '
          + 'mobile hotspot.',
      });
      tried.forEach((c) => { try { c.close(); } catch {} });
      this.scheduleReconnect(300);   // straight on to the next wave of slots
    }, 5000);
    this.timers.push(watchdog);

    tried.forEach((conn) => {
      conn.on('open', () => {
        if (won || this.state.conn === 'connected') { try { conn.close(); } catch {} return; }
        won = conn;
        this.conn = conn;
        this.peer = peer;
        // drop the brokers we no longer need
        this.peers.forEach((p) => { if (p !== peer) { try { p.destroy(); } catch {} } });
        this.peers = [peer];
        window.clearTimeout(watchdog);
        tried.forEach((o) => { if (o !== conn) { try { o.close(); } catch {} } });
        this.onConnected(conn);
      });
      conn.on('data', (d) => {
        if (won !== conn) return;
        this.lastInbound = Date.now();
        void this.handle(d as P2PMessage);
      });
      const lost = () => {
        if (won !== conn || this.conn !== conn) return;         // a dead slot, not our host
        this.set({
          conn: 'reconnecting', hostOnline: false,
          info: this.transportPlaying ? 'Offline — playing from this phone.' : null,
        });
        this.scheduleReconnect();
      };
      conn.on('close', lost);
      conn.on('error', lost);
    });
  }

  private onConnected(conn: DataConnection) {
    this.retry = 0;
    this.set({ conn: 'connected', sessionId: conn.peer, error: null, info: null,
      phase: this.audioEnabled ? 'AUDIO_READY' : 'AUDIO_DISABLED', hostOnline: true });
    void trackIds().then((cached) => {
      this.cachedIds = cached;
      this.send({ type: 'HELLO', deviceId: deviceId(), cached });
    });
    // A data channel is much jitterier than a WebSocket right after it opens,
    // and a bad offset here shows up directly as phones being apart. So we
    // probe hard for the first few seconds and keep a steady 1 Hz afterwards;
    // ClockSync keeps only the lowest-RTT third of the samples.
    for (let i = 0; i < 10; i++) this.timers.push(window.setTimeout(() => this.ping(), i * 150));
    this.timers.push(window.setInterval(() => this.ping(), 1000));
    this.lastInbound = Date.now();
    // PeerJS does not always fire 'close' when the host tab goes away (a
    // refresh, a crash, a dead Wi-Fi link). The host answers every PING, so
    // silence longer than a few seconds means the channel is gone.
    this.timers.push(window.setInterval(() => {
      if (this.closed || this.reconnectPending) return;
      if (Date.now() - this.lastInbound > 6000) {
        this.set({
          conn: 'reconnecting', hostOnline: false,
          info: this.transportPlaying
            ? 'Lost the host — still playing from this phone, will re-sync automatically.'
            : 'Lost the host — reconnecting…',
        });
        try { this.conn?.close(); } catch {}
        this.scheduleReconnect();
      }
    }, 2000));
    this.startReporting();
  }


  /**
   * A dropped chunk used to mean the file never completed and that phone stayed
   * silent for the whole song. Now we notice the gap and ask for exactly the
   * missing pieces again.
   */
  /** Point playback at a complete track, wherever the bytes came from. */
  private adoptTrack(trackId: string, title: string, blob: Blob) {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(blob);
    this.blob = blob;
    this.trackId = trackId;
    this.haveTrack = trackId;
    this.set({ trackTitle: title, trackArtist: '', info: null, bufferedPct: 100 });
    if (this.audioEnabled) this.loadAudio();
    this.send({ type: 'TRACK_READY', trackId });
    // we may have been told to play while the file was still arriving
    if (this.transportPlaying) this.catchUp();
  }

  /** Play the host's live microphone alongside the music. */
  private micAudio: HTMLAudioElement | null = null;
  private playMic(stream: MediaStream) {
    if (!this.micAudio) {
      const a = new Audio();
      (a as any).playsInline = true;
      a.autoplay = true;
      this.micAudio = a;
    }
    this.micAudio.srcObject = stream;
    this.micAudio.muted = false;
    this.micAudio.volume = this.state.volume ?? 1;
    void this.micAudio.play().catch(() => {
      this.set({ info: 'Tap the screen once to let the host\u2019s microphone through.' });
      const retry = () => {
        void this.micAudio?.play().then(() => this.set({ info: 'The host is speaking live.' })).catch(() => {});
        document.removeEventListener('pointerdown', retry);
      };
      document.addEventListener('pointerdown', retry);
    });
    this.set({ info: 'The host is speaking live.', hostMic: true });
  }

  private stopMic() {
    if (!this.micAudio) return;
    try { this.micAudio.pause(); } catch {}
    this.micAudio.srcObject = null;
    this.set({ info: null, hostMic: false });
  }

  private startChunkChase() {
    window.clearInterval(this.chaseTimer);
    this.chaseTimer = window.setInterval(() => {
      const inc = this.incoming;
      if (!inc) { window.clearInterval(this.chaseTimer); return; }
      if (Date.now() - this.lastChunkAt < 2500) return;
      const missing: number[] = [];
      for (let i = 0; i < inc.chunks && missing.length < 400; i++) if (!inc.parts[i]) missing.push(i);
      if (!missing.length) return;
      this.lastChunkAt = Date.now();
      this.set({ info: `Re-requesting ${missing.length} missing piece(s) of the track…` });
      this.send({ type: 'TRACK_NEED', trackId: inc.trackId, indexes: missing });
    }, 1200);
    this.timers.push(this.chaseTimer);
  }

  private scheduleReconnect(fixedWait?: number) {
    if (this.closed || this.reconnectPending) return;
    if (this.conn?.open) return;              // already have a live channel
    this.reconnectPending = true;
    this.retry++;
    // While we are still scanning the slot list, keep the hops quick.
    const wait = fixedWait ?? Math.min(15000, 600 * 2 ** Math.min(this.retry, 5));
    this.timers.push(window.setTimeout(() => {
      this.reconnectPending = false;
      if (this.closed) return;
      try { this.peers.forEach((p) => p.destroy()); } catch {}
      this.connect();
    }, wait));
  }

  private send(m: P2PMessage) { try { if (this.conn?.open) this.conn.send(m); } catch {} }
  private ping() { this.send({ type: 'PING', t1: Date.now() }); }

  /* ------------------------------- events ------------------------------ */

  private async handle(m: P2PMessage) {
    // The host sends every transport command three times so a weak link
    // cannot swallow it. Applying the same one twice would re-schedule
    // playback, so anything we have already acted on is dropped here.
    if ('seq' in m && typeof (m as any).seq === 'number' && m.type !== 'STATE'
        && (m as any).seq <= this.appliedSeq) return;
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

      case 'TRACK_META': {
        // already have these exact bytes — never swap the blob we are playing
        if (this.haveTrack === m.trackId && this.objectUrl) {
          this.send({ type: 'TRACK_READY', trackId: m.trackId });
          break;
        }
        // or we downloaded it on an earlier night: nothing to transfer at all
        const cached = await getTrack(m.trackId);
        if (cached) {
          this.adoptTrack(m.trackId, cached.title, new Blob([cached.bytes], { type: cached.mimeType }));
          break;
        }
        this.incoming = {
          trackId: m.trackId, title: m.title, mime: m.mime, chunks: m.chunks,
          parts: new Array(m.chunks), got: 0,
        };
        this.set({ trackTitle: m.title, info: m.chunks > 8 ? 'Receiving the track…' : null, bufferedPct: 0 });
        this.lastChunkAt = Date.now();
        this.startChunkChase();
        break;
      }

      case 'TRACK_CHUNK': {
        const inc = this.incoming;
        if (!inc || inc.trackId !== m.trackId || inc.parts[m.index]) break;
        inc.parts[m.index] = m.bytes;
        inc.got++;
        this.lastChunkAt = Date.now();
        this.set({ bufferedPct: Math.round((inc.got / inc.chunks) * 100) });
        if (inc.got < inc.chunks) break;

        const blob = new Blob(inc.parts as ArrayBuffer[], { type: inc.mime || 'audio/mpeg' });
        window.clearInterval(this.chaseTimer);
        this.incoming = null;
        // keep it: this phone never needs to download this song again, even
        // after a refresh or a night offline
        void blob.arrayBuffer().then((bytes) => {
          void putTrack({
            id: inc.trackId, title: inc.title, artist: '', filename: inc.title,
            mimeType: inc.mime || 'audio/mpeg', size: bytes.byteLength, duration: 0, bytes,
          });
          if (!this.cachedIds.includes(inc.trackId)) this.cachedIds.push(inc.trackId);
        });
        this.adoptTrack(inc.trackId, inc.title, blob);
        break;
      }

      case 'CLOCK_BIAS':
        // Deliberately ignored: see the note in p2pHost.ts. Kept in the wire
        // format so an older host cannot break a newer speaker.
        break;

      case 'STATE': {
        // full repair snapshot from the host
        this.appliedSeq = Math.max(this.appliedSeq, m.seq);
        this.transportPlaying = m.playing;
        this.basePosition = m.position;
        this.baseHostTime = m.atHostTime;
        this.set({ playing: m.playing, volume: m.volume, trackTitle: m.title || this.state.trackTitle });
        this.applyVolume();
        if (!this.audioEnabled) break;
        if (m.playing) this.catchUp();
        else { this.audio?.pause(); try { if (this.audio) this.audio.currentTime = m.position; } catch {} }
        break;
      }

      case 'PLAY':
        this.appliedSeq = Math.max(this.appliedSeq, m.seq);
        this.transportPlaying = true;
        this.basePosition = m.position;
        this.baseHostTime = m.startAt;
        this.set({ playing: true });
        if (!this.audioEnabled) { this.set({ phase: 'AUDIO_DISABLED' }); break; }
        this.loadAudio();
        this.schedulePlay(m.position, m.startAt);
        break;

      case 'PAUSE': {
        this.appliedSeq = Math.max(this.appliedSeq, m.seq);
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
        this.appliedSeq = Math.max(this.appliedSeq, m.seq);
        this.transportPlaying = false;
        this.basePosition = 0;
        if (this.playTimer) window.clearTimeout(this.playTimer);
        if (this.audio) { this.audio.pause(); try { this.audio.currentTime = 0; } catch {} }
        this.set({ playing: false, position: 0, phase: this.audioEnabled ? 'AUDIO_READY' : 'AUDIO_DISABLED' });
        break;

      case 'SEEK': {
        this.appliedSeq = Math.max(this.appliedSeq, m.seq);
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
        this.appliedSeq = Math.max(this.appliedSeq, m.seq);
        this.transportPlaying = m.playing;
        this.basePosition = m.position;
        this.baseHostTime = m.atHostTime;
        this.drift.reset();
        this.set({ playing: m.playing });
        if (this.audioEnabled) this.catchUp();
        break;

      case 'VOLUME':
        this.appliedSeq = Math.max(this.appliedSeq, m.seq);
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
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    if (!this.el) {
      const a = new Audio();
      a.preload = 'auto';
      (a as any).playsInline = true;
      a.addEventListener('loadedmetadata', () => this.set({ duration: a.duration || 0 }));
      a.addEventListener('progress', () => this.updateBuffered());
      this.el = a;
      // Diagnostics / e2e only: a live view of whichever output is actually
      // playing, so tools do not have to know which path we took.
      (window as any).__syncAudio = {
        get currentTime() { return self.audio?.currentTime ?? 0; },
        get paused() { return self.audio ? self.audio.paused : true; },
        get playbackRate() { return self.audio?.playbackRate ?? 1; },
        get duration() { return self.audio?.duration ?? 0; },
        get engine() { return self.wa?.ready ? 'webaudio' : 'element'; },
        get element() { return self.el; },
      };
    }
    try {
      this.el.muted = true;
      this.el.src = SILENT_WAV;
      await this.el.play();
      this.el.pause();
      this.el.currentTime = 0;
      this.el.muted = false;
      // An AudioContext must also be created and resumed inside the original
      // tap — Android leaves a later one suspended, which would silently drop
      // us back to the stuttering element path.
      if (!this.ctx) {
        const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
        if (Ctor) {
          this.ctx = new Ctor({ latencyHint: 'playback' }) as AudioContext;
          this.wa = new WebAudioPlayer(this.ctx);
          (window as any).__syncWA = this.wa; // diagnostics / e2e only
        }
      }
      if (this.ctx?.state === 'suspended') { try { await this.ctx.resume(); } catch {} }
      // Unlock a SECOND element in the same gesture: Android blocks a fresh
      // <audio> created later, which is why the host's live microphone was
      // silent on a real phone even though the track arrived.
      if (!this.micAudio) {
        const m = new Audio();
        (m as any).playsInline = true;
        m.autoplay = true;
        m.muted = true;
        m.src = SILENT_WAV;
        try { await m.play(); m.pause(); } catch { /* best effort */ }
        m.muted = false;
        this.micAudio = m;
      }
      this.audioEnabled = true;
      this.keepPlayingWhenLocked();
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
    const el = this.el;
    if (!el || !this.objectUrl || !this.trackId) return;
    // compare the actual source, not just the id: after a host refresh the id
    // is the same but the blob behind it is new
    if (el.dataset.audioId !== this.trackId || el.src !== this.objectUrl) {
      el.src = this.objectUrl;
      el.dataset.audioId = this.trackId;
      el.load();
    }
    this.decodeForExactPlayback();
    this.applyVolume();
  }

  /**
   * Decode the song into memory so playback can be scheduled exactly.
   * Costs a second or two of CPU once; buys a song that never re-buffers.
   */
  private decodedId: string | null = null;
  private decodeForExactPlayback() {
    const blob = this.blob;
    const id = this.trackId;
    if (!this.wa || !blob || !id || this.decoding || this.decodedId === id) return;
    this.decoding = true;
    void this.wa.load(blob)
      .then(() => {
        this.decodedId = id;
        this.set({ duration: this.wa?.duration || this.state.duration, bufferedPct: 100 });
        // hand over from the element mid-song without a gap
        if (this.transportPlaying && this.audioEnabled) {
          try { this.el?.pause(); } catch {}
          this.resyncExact();
          this.set({ phase: 'PLAYING', playing: true, info: null });
        }
        this.applyVolume();
      })
      .catch(() => { /* undecodable format — the element fallback still works */ })
      .finally(() => { this.decoding = false; });
  }

  private applyVolume() {
    const v = this.state.muted ? 0 : this.state.volume;
    if (this.el) this.el.volume = v;
    if (this.wa) this.wa.volume = v;
  }

  private updateBuffered() {
    const a = this.audio;
    if (!a || !a.duration) return;
    if (this.wa?.ready) { this.set({ bufferedPct: 100 }); return; }
    const end = a.buffered.length ? a.buffered.end(a.buffered.length - 1) : 0;
    this.set({ bufferedPct: Math.min(100, (end / a.duration) * 100) });
  }

  /**
   * Per-device output delay, in milliseconds.
   *
   * Aligning `currentTime` is not enough in the real world: every phone has
   * its own audio output latency (decoder + mixer + Bluetooth), easily 50–250
   * ms apart, and that is exactly what you hear as an echo between two phones.
   * No browser API reports it, so this is a manual nudge the listener can set
   * once per phone; it is remembered on that device.
   */
  /** Always 0 — the host-driven bias loop was removed (see p2pHost.ts). */
  private clockBias = 0;

  get outputOffsetMs() { return Number(localStorage.getItem('sm.outOffset') || 0); }
  setOutputOffsetMs(ms: number) {
    const v = Math.max(-500, Math.min(500, Math.round(ms)));
    localStorage.setItem('sm.outOffset', String(v));
    this.set({});
    this.realign();
  }

  private targetPosition() {
    return projectPosition(
      this.basePosition, this.baseHostTime,
      this.clock.now() + this.outputOffsetMs + this.clockBias, this.transportPlaying,
      this.state.duration || Infinity,
    );
  }

  /** Snap onto the timeline now (used when the clock estimate jumps). */
  private realign() {
    const a = this.audio;
    if (!a || !this.audioEnabled || !this.transportPlaying || a.paused) return;
    if (this.wa?.ready) { this.resyncExact(); return; }
    const target = this.targetPosition();
    if (Math.abs(a.currentTime - target) < 0.03) return;
    try { a.currentTime = target; } catch {}
    a.playbackRate = 1;
    this.drift.reset();
  }

  private schedulePlay(position: number, startAt: number) {
    const a = this.audio;
    if (!a) return;
    // The element stutters — that is the whole reason the decoded player
    // exists. So if the song is not decoded yet we stay SILENT and say so,
    // rather than producing the broken sound and "fixing" it later.
    if (this.wa && !this.wa.ready) {
      this.decodeForExactPlayback();
      this.set({ phase: 'SYNCING', info: 'Preparing the song on this phone — it will join in a moment.' });
      return;
    }
    if (this.playTimer) window.clearTimeout(this.playTimer);
    this.set({ phase: 'SYNCING' });

    // Decoded path: no setTimeout, no play() latency, no guessing. We hand the
    // audio hardware the exact instant to begin and it obeys to the sample.
    if (this.wa?.ready) {
      const leadMs = startAt - this.clock.now() - this.outputOffsetMs;
      this.wa.scheduleStart(position, leadMs / 1000);
      this.set({ phase: 'PLAYING', playing: true });
      this.drift.reset();
      return;
    }

    const arm = () => {
      const lead = startAt - this.clock.now();
      if (lead <= 0) { this.catchUp(); return; }
      try { a.currentTime = position; } catch {}
      this.playTimer = window.setTimeout(() => {
        // The host may have paused, stopped or seeked while we were waiting:
        // a stale scheduled start used to make one phone play on its own.
        if (!this.transportPlaying || this.baseHostTime !== startAt) return;
        const err = startAt - this.clock.now();
        try { a.currentTime = position - Math.min(0, err) / 1000; } catch {}
        void a.play()
          .then(() => {
            if (!this.transportPlaying) { try { a.pause(); } catch {} return; }
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
    if (this.wa && !this.wa.ready) {
      this.decodeForExactPlayback();
      this.set({ phase: 'SYNCING', info: 'Preparing the song on this phone — it will join in a moment.' });
      return;
    }
    const untilStart = this.baseHostTime - this.clock.now();
    if (this.transportPlaying && untilStart > 20) { this.schedulePlay(this.basePosition, this.baseHostTime); return; }
    const target = this.targetPosition();
    void target;
    if (this.wa?.ready && this.transportPlaying) {
      this.resyncExact();
      this.set({ phase: 'PLAYING', playing: true });
      return;
    }
    try { a.currentTime = target; } catch {}
    if (this.transportPlaying) {
      void a.play()
        .then(() => this.set({ phase: 'PLAYING', playing: true }))
        .catch(() => this.set({ phase: 'AUDIO_DISABLED', error: 'Your browser blocked audio. Tap Enable Speaker.' }));
    }
  }

  /**
   * Survive a locked screen.
   *
   * Android keeps a page's <audio> playing when the screen goes off, but only
   * if the system sees it as real media playback — so we publish Media Session
   * metadata and keep the session's play/pause handlers pointed at the host.
   * We also hold a screen wake lock while the page is visible, which is what
   * stops a phone from suspending Wi-Fi mid-song. The honest limit: the tab
   * must stay open, and some battery savers will still stop it.
   */
  /**
   * Android suspends an AudioContext when the screen goes off or the system
   * takes the audio focus, and a suspended context is simply silence. Watch
   * for it and bring it back, then land exactly back on the timeline.
   */
  private keepContextAwake() {
    const revive = () => {
      const ctx = this.ctx;
      if (!ctx || !this.audioEnabled) return;
      if (ctx.state !== 'running') {
        void ctx.resume()
          .then(() => { if (this.transportPlaying) this.resyncExact(); })
          .catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', revive);
    window.addEventListener('focus', revive);
    this.timers.push(window.setInterval(revive, 2000));
  }

  private keepPlayingWhenLocked() {
    this.keepContextAwake();
    try {
      const ms = (navigator as any).mediaSession;
      if (ms) {
        ms.setActionHandler?.('play', () => { /* the host owns transport */ });
        ms.setActionHandler?.('pause', () => { /* ignore: the host owns transport */ });
        ms.setActionHandler?.('stop', () => { /* ignore */ });
        ms.metadata = new (window as any).MediaMetadata({
          title: this.state.trackTitle || 'Sync Music',
          artist: 'Synchronized speaker',
          album: this.state.sessionName || 'Sync Music',
        });
        ms.playbackState = 'playing';
      }
    } catch { /* Media Session is optional */ }

    const lock = async () => {
      try {
        if (document.visibilityState !== 'visible') return;
        this.wakeLock = await (navigator as any).wakeLock?.request('screen');
      } catch { /* denied or unsupported — playback still continues */ }
    };
    void lock();
    document.addEventListener('visibilitychange', () => {
      void lock();
      // Coming back from a locked screen: re-check our place in the timeline.
      if (document.visibilityState === 'visible' && this.transportPlaying) this.realign();
    });
  }

  private wakeLock: any = null;
  private cachedIds: string[] = [];
  private bigErrors = 0;
  private lastErr = 0;

  private startReporting() {
    const report = () => {
      const a = this.audio;
      const buffered = a && a.buffered.length ? a.buffered.end(a.buffered.length - 1) - a.currentTime : 0;
      this.send({
        type: 'STATUS', position: a?.currentTime ?? 0, atHostTime: this.clock.now(),
        rate: a?.playbackRate ?? 1, playing: !!a && !a.paused, buffered: Math.max(0, buffered),
        clockRtt: Math.round(this.clock.rtt), clockSynced: this.clock.synced,
        clockSamples: this.clock.sampleCount,
        seq: this.appliedSeq, haveTrack: this.haveTrack, cached: this.cachedIds,
        selfDriftMs: a && !a.paused ? Math.round((a.currentTime - this.targetPosition()) * 1000) : 0,
      });
      this.timers.push(window.setTimeout(report, 600));
    };
    report();
    this.timers.push(window.setInterval(() => this.correctDrift(), 500));
  }

  /**
   * Put the decoded player exactly on the timeline.
   *
   * With Web Audio this is cheap and precise — we simply tell the hardware to
   * begin a fraction of a second from now at the position the song will have
   * reached by then. Unlike an element seek there is no re-buffering, so it is
   * the right tool for anything above a few tens of milliseconds.
   */
  private resyncExact() {
    const wa = this.wa;
    if (!wa?.ready || !this.transportPlaying) return;
    const lead = 0.06;
    wa.playbackRate = 1;
    wa.scheduleStart(this.targetPosition() + lead, lead);
    this.drift.reset();
    this.bigErrors = 0;
  }

  private correctDrift() {
    const a = this.audio;
    // Wait for a usable offset, not a perfect one: right after a (re)connect
    // the estimate is still settling, and refusing to correct during those
    // seconds is exactly when a phone drifts audibly away from the others.
    const usable = this.clock.synced || this.clock.sampleCount >= 3;
    if (!a || !this.audioEnabled || !this.transportPlaying || a.paused || !usable) {
      if (a) this.set({ position: a.currentTime });
      return;
    }
    const target = this.targetPosition();
    const err = a.currentTime - target;

    // Decoded path: a reschedule is sample-accurate and does not re-buffer, so
    // close anything audible straight away and ride the rest on a 0.3% ramp
    // that nobody can hear.
    if (this.wa?.ready) {
      if (Math.abs(err) > 0.03) {
        this.resyncExact();
        this.set({ driftMs: Math.round(err * 1000), phase: 'PLAYING', position: a.currentTime });
        return;
      }
      a.playbackRate = Math.abs(err) < 0.008 ? 1 : (err > 0 ? 0.997 : 1.003);
      this.set({ position: a.currentTime, driftMs: Math.round(err * 1000), phase: 'PLAYING' });
      return;
    }
    // Safety net above the normal policy: a phone that is more than ~120 ms
    // out is plainly audible as an echo, and nudging playbackRate would take
    // tens of seconds to close that. Snap it, then let the gentle loop keep it
    // there. (Below this the policy still prefers an inaudible rate change.)
    // A phone's clock estimate jitters, especially on mobile data. Snapping on
    // a single bad sample is audible as a tick, and repeated ticks are exactly
    // the "ruk ruk" stutter. So a seek needs THREE consecutive readings that
    // agree, and in between we lean on the (inaudible) rate change.
    if (Math.abs(err) > 0.12) {
      this.bigErrors = Math.sign(err) === Math.sign(this.lastErr) ? this.bigErrors + 1 : 1;
      this.lastErr = err;
      if (this.bigErrors >= 3) {
        this.bigErrors = 0;
        try { a.currentTime = target; } catch {}
        a.playbackRate = 1;
        this.set({ position: a.currentTime, driftMs: Math.round(err * 1000), phase: 'PLAYING' });
        this.updateBuffered();
        return;
      }
      // With an exact start the error is small and slow, so nudge by 0.5%
      // (inaudible) rather than 2% (a noticeable pitch wobble).
      a.playbackRate = err > 0 ? 0.995 : 1.005;
      this.set({ position: a.currentTime, driftMs: Math.round(err * 1000), phase: 'PLAYING' });
      this.updateBuffered();
      return;
    }
    this.bigErrors = 0;
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
    try { this.el?.pause(); } catch {}
    this.wa?.dispose();
    try { void this.ctx?.close(); } catch {}
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
