/**
 * Sample-accurate playback for a speaker phone.
 *
 * Why this exists: an `<audio>` element is the wrong instrument for group
 * playback. The browser owns its buffering, it can stall for tens of
 * milliseconds whenever the decoder or the Wi-Fi radio hiccups, `play()`
 * starts "soon" rather than at a stated instant, and every `currentTime`
 * write is an audible seek. On a real phone that adds up to the stutter you
 * hear — and the drift loop then makes it worse by correcting against it.
 *
 * So once a track has arrived in full we decode it ONCE into memory and play
 * it through Web Audio. Starting is then scheduled against the audio
 * hardware's own clock (`AudioContext.currentTime`) with sub-millisecond
 * precision, nothing re-buffers mid-song because there is nothing left to
 * fetch, and small corrections are a smooth rate ramp instead of a seek.
 *
 * It deliberately mimics the slice of the HTMLAudioElement API the speaker
 * already used (`currentTime`, `paused`, `play`, `pause`, `playbackRate`,
 * `volume`, `duration`, `buffered`), so the rest of the client is unchanged.
 *
 * Honest limits: decoding holds the whole song as PCM in memory (about
 * 21 MB per minute for stereo 44.1 kHz float32 — the old "10 MB" figure here
 * was wrong by half, so a 16-minute track is ~340 MB), and it needs the complete file, so a
 * track that is still arriving still plays through the element fallback.
 */
import { MixerChannel, loadSettings } from '../audio/mixer';

export class WebAudioPlayer {
  readonly ctx: AudioContext;
  /** the music channel strip: EQ, echo, limiter, level */
  readonly mixer: MixerChannel;
  private gain: GainNode;
  private buffer: AudioBuffer | null = null;
  private src: AudioBufferSourceNode | null = null;

  /** mapping from context time to position, valid while playing */
  private baseOffset = 0;        // position (s) at baseCtxTime
  private baseCtxTime = 0;       // ctx.currentTime when that position plays
  private rate = 1;
  private stopped = true;
  private pending = 0;           // position while paused
  private _volume = 1;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.gain = ctx.createGain();
    // everything the music plays goes through its own channel strip
    this.mixer = new MixerChannel(ctx);
    this.mixer.apply(loadSettings('music'));
    this.gain.connect(this.mixer.input);
  }

  /**
   * Decode a complete file WITHOUT touching what is playing. Throws if the
   * browser cannot decode it.
   *
   * This used to assign the result straight into `this.buffer`. If the host
   * changed song while a decode was still running, the OLD song's decode
   * finished later and silently overwrote the new song's state, so a phone
   * showed one title and played another song's audio. Decoding and installing
   * are now separate steps and the caller decides whether the result is still
   * wanted.
   */
  async decode(blob: Blob): Promise<AudioBuffer> {
    const bytes = await blob.arrayBuffer();     // a fresh copy each call; decodeAudioData detaches it
    return this.ctx.decodeAudioData(bytes);
  }

  /** Make a decoded song the current one (null = forget the song). */
  setBuffer(buf: AudioBuffer | null) {
    this.teardown();
    this.buffer = buf;
    this.pending = 0;
  }

  /** Approximate PCM memory held by the installed song (float32). */
  get bytesHeld(): number {
    const b = this.buffer;
    return b ? b.length * b.numberOfChannels * 4 : 0;
  }

  /**
   * Route an <audio> element through this same channel strip.
   *
   * Without this the mixer was a lie whenever the element was the thing
   * making sound — while a song was still arriving, or when the phone could
   * not decode the file — because the element talks straight to the speaker
   * and never passes through the EQ or the echo. A browser allows only one
   * source node per element, so it is created once and kept.
   */
  private elSource: MediaElementAudioSourceNode | null = null;
  private elAttached: HTMLAudioElement | null = null;
  attachElement(el: HTMLAudioElement): boolean {
    if (this.elAttached === el) return true;
    // Careful: once an element is routed into Web Audio it is SILENT while
    // the context is suspended. Only take it over when the context is
    // actually running, so a phone can never end up muted by the mixer.
    if (this.ctx.state !== 'running') { void this.ctx.resume().catch(() => {}); return false; }
    try {
      this.elSource?.disconnect();
      this.elSource = this.ctx.createMediaElementSource(el);
      this.elSource.connect(this.mixer.input);
      this.elAttached = el;
      return true;
    } catch {
      // already attached to another context, or the browser refused: the
      // element still plays, just without the EQ
      return false;
    }
  }

  get ready() { return !!this.buffer; }
  get duration() { return this.buffer?.duration ?? 0; }
  get paused() { return this.stopped; }

  /** Fully in memory — there is nothing left to buffer. */
  get buffered() {
    const d = this.duration;
    return { length: d ? 1 : 0, end: () => d, start: () => 0 } as unknown as TimeRanges;
  }

  /**
   * How far behind the speaker the scheduled timeline is: the hardware buffer
   * the browser keeps between us and the driver. Chrome reports it; others
   * only report the context's base latency. Reporting positions in AUDIBLE
   * time means the drift loop lines up what people actually hear, not what
   * was queued — on phones with different buffer sizes that is tens of ms.
   */
  private frozenLatency: number | null = null;
  get outputLatency(): number {
    // Read ONCE. Chrome on Android re-reports this value as the buffer
    // breathes, and feeding that jitter into the position would make the sync
    // loop chase a moving target — which is heard as chopping.
    if (this.frozenLatency === null) {
      const c = this.ctx as any;
      const l = Number(c.outputLatency ?? c.baseLatency ?? 0);
      this.frozenLatency = Number.isFinite(l) && l >= 0 && l < 0.5 ? l : 0;
    }
    return this.frozenLatency;
  }

  get currentTime(): number {
    if (this.stopped || !this.buffer) return this.pending;
    // Before a scheduled start actually fires, the song is still sitting at
    // its start position — reporting a negative elapsed time would look like
    // playback running backwards.
    const elapsed = this.ctx.currentTime - this.baseCtxTime - this.outputLatency;
    const t = this.baseOffset + Math.max(0, elapsed) * this.rate;
    return Math.max(0, Math.min(t, this.buffer.duration));
  }

  set currentTime(t: number) {
    const pos = Math.max(0, t);
    if (this.stopped) { this.pending = pos; return; }
    this.startFrom(pos, this.ctx.currentTime);
  }

  get playbackRate() { return this.rate; }
  set playbackRate(r: number) {
    const clamped = Math.max(0.9, Math.min(1.1, r));
    if (Math.abs(clamped - this.rate) < 1e-4) return;
    if (this.stopped || !this.src) { this.rate = clamped; return; }
    // re-anchor so `currentTime` stays continuous across the rate change,
    // then ramp instead of jumping — a step in rate is audible as a click
    this.baseOffset = this.currentTime;
    this.baseCtxTime = this.ctx.currentTime;
    this.rate = clamped;
    try {
      this.src.playbackRate.cancelScheduledValues(this.ctx.currentTime);
      this.src.playbackRate.setTargetAtTime(clamped, this.ctx.currentTime, 0.08);
    } catch { this.src.playbackRate.value = clamped; }
  }

  get volume() { return this._volume; }
  set volume(v: number) {
    this._volume = Math.max(0, Math.min(1, v));
    const now = this.ctx.currentTime;
    try {
      this.gain.gain.cancelScheduledValues(now);
      this.gain.gain.setTargetAtTime(this._volume, now, 0.02);
    } catch { this.gain.gain.value = this._volume; }
  }

  /** Start now, from wherever we were paused. */
  play(): Promise<void> {
    if (!this.buffer) return Promise.reject(new Error('no buffer'));
    if (!this.stopped) return Promise.resolve();
    this.startFrom(this.pending, this.ctx.currentTime);
    return Promise.resolve();
  }

  /**
   * The point of the whole class: begin exactly `leadSeconds` from now, at
   * `position` in the song. A negative lead means the moment has already
   * passed, so we start immediately that much further into the song.
   */
  scheduleStart(position: number, leadSeconds: number) {
    if (!this.buffer) return;
    // Queueing audio at context time T means it is AUDIBLE at T + latency, so
    // to be heard on time we must queue it that much earlier. Positions are
    // reported in audible time for the same reason; doing one without the
    // other leaves every phone late by its own buffer size, which is exactly
    // the kind of fixed per-device error that shows up as phones not being
    // together.
    const lead = leadSeconds - this.outputLatency;
    if (lead <= 0) {
      this.startFrom(position - lead, this.ctx.currentTime);
      return;
    }
    this.startFrom(position, this.ctx.currentTime + lead);
  }

  pause() {
    const at = this.currentTime;
    this.teardown();
    this.pending = at;
  }

  stop() { this.teardown(); this.pending = 0; }

  onended: (() => void) | null = null;

  /* ----------------------------------------------------------------- */

  private startFrom(position: number, whenCtxTime: number) {
    if (!this.buffer) return;
    const offset = Math.max(0, Math.min(position, this.buffer.duration));
    this.teardown();

    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this.rate;
    // A 6 ms fade in its own gain node: restarting a buffer mid-waveform
    // would otherwise click, and a correction you can hear is worse than the
    // drift it fixes.
    const fade = this.ctx.createGain();
    const at = Math.max(whenCtxTime, this.ctx.currentTime);
    fade.gain.setValueAtTime(0, at);
    fade.gain.linearRampToValueAtTime(1, at + 0.006);
    fade.connect(this.gain);
    src.connect(fade);
    (src as any).__fadeNode = fade;
    src.onended = () => { if (this.src === src) { this.stopped = true; this.onended?.(); } };
    src.start(at, offset);

    this.src = src;
    this.baseOffset = offset;
    this.baseCtxTime = whenCtxTime;
    this.stopped = false;
  }

  private teardown() {
    const s = this.src;
    this.src = null;
    this.stopped = true;
    if (!s) return;
    try { s.onended = null; } catch {}
    // fade the outgoing source out over 6 ms instead of cutting it
    const now = this.ctx.currentTime;
    const out = s as AudioBufferSourceNode & { __fade?: GainNode };
    try {
      const g = (s as any).__fadeNode as GainNode | undefined;
      if (g) {
        g.gain.cancelScheduledValues(now);
        g.gain.setValueAtTime(g.gain.value, now);
        g.gain.linearRampToValueAtTime(0, now + 0.006);
      }
      s.stop(now + 0.008);
      window.setTimeout(() => { try { s.disconnect(); } catch {} }, 60);
    } catch {
      try { s.stop(); } catch {}
      try { s.disconnect(); } catch {}
    }
    void out;
  }

  /** Forget the song. Used when the host switches track: `ready` must go
   *  false immediately so nothing can schedule the previous buffer. */
  clear() { this.setBuffer(null); }

  dispose() { this.teardown(); try { this.gain.disconnect(); } catch {} }
}
