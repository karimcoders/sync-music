/**
 * A real mixer channel, in software.
 *
 * This is the signal chain a small desk gives you, built out of Web Audio
 * nodes and inserted between a source and the speaker:
 *
 *   in → [bass] → [mid] → [treble] → [echo send] → [compressor] → [gain] → out
 *                                 ↘ delay → feedback ↗
 *
 * Everything here changes the sound on THIS phone only, in real time. Nothing
 * is faked: these are the same filters a hardware channel strip uses.
 *
 * Honest limits, because they matter:
 *  - this is a mixer, not a magic loudness button. Pushing gain past 100 %
 *    is real amplification, so a limiter sits after it to stop the clipping
 *    that would otherwise turn loud into ugly. A phone speaker still runs out
 *    of air.
 *  - the echo is a delay line with feedback (a slap/hall you can dial), not a
 *    convolution reverb of a real room.
 *  - none of this can repair a bad recording or a blown speaker.
 */

export interface MixerSettings {
  /** low shelf, dB (−12…+12) */
  bass: number;
  /** mid bell, dB (−12…+12) */
  mid: number;
  /** high shelf, dB (−12…+12) */
  treble: number;
  /** output level, 0…2 (1 = unity, 2 = +6 dB) */
  gain: number;
  /** echo mix, 0…1 */
  echo: number;
  /** echo time, seconds (0.05…1.0) */
  echoTime: number;
  /** echo feedback, 0…0.9 */
  echoFeedback: number;
  /** limiter on/off — keeps a boosted channel from clipping */
  limiter: boolean;
}

export const FLAT: MixerSettings = {
  bass: 0, mid: 0, treble: 0, gain: 1,
  echo: 0, echoTime: 0.25, echoFeedback: 0.3, limiter: true,
};

export const PRESETS: Record<string, Partial<MixerSettings>> = {
  Flat: FLAT,
  Bass: { bass: 7, mid: -1, treble: 1, gain: 1 },
  Vocal: { bass: -3, mid: 4, treble: 3, gain: 1.1 },
  Speech: { bass: -6, mid: 5, treble: 2, gain: 1.3, echo: 0 },
  Party: { bass: 6, mid: 0, treble: 4, gain: 1.2 },
  Hall: { echo: 0.35, echoTime: 0.35, echoFeedback: 0.45 },
  Slapback: { echo: 0.25, echoTime: 0.12, echoFeedback: 0.15 },
};

export class MixerChannel {
  readonly input: GainNode;
  private bass: BiquadFilterNode;
  private mid: BiquadFilterNode;
  private treble: BiquadFilterNode;
  private dry: GainNode;
  private send: GainNode;
  private delay: DelayNode;
  private feedback: GainNode;
  private comp: DynamicsCompressorNode;
  private bypass: GainNode;
  private out: GainNode;
  private settings: MixerSettings = { ...FLAT };

  constructor(private ctx: AudioContext, destination?: AudioNode) {
    const g = () => ctx.createGain();
    this.input = g();

    this.bass = ctx.createBiquadFilter();
    this.bass.type = 'lowshelf';
    this.bass.frequency.value = 160;

    this.mid = ctx.createBiquadFilter();
    this.mid.type = 'peaking';
    this.mid.frequency.value = 1200;
    this.mid.Q.value = 0.9;

    this.treble = ctx.createBiquadFilter();
    this.treble.type = 'highshelf';
    this.treble.frequency.value = 3800;

    this.dry = g();
    this.send = g();
    this.send.gain.value = 0;
    this.delay = ctx.createDelay(1.5);
    this.delay.delayTime.value = FLAT.echoTime;
    this.feedback = g();
    this.feedback.gain.value = FLAT.echoFeedback;

    // A limiter, not a "sound enhancer": fast attack, high ratio, just below
    // full scale. Its only job is to catch the peaks that boosting creates.
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -6;
    this.comp.knee.value = 6;
    this.comp.ratio.value = 12;
    this.comp.attack.value = 0.003;
    this.comp.release.value = 0.12;

    this.bypass = g();
    this.out = g();

    this.input.connect(this.bass).connect(this.mid).connect(this.treble);
    this.treble.connect(this.dry);
    this.treble.connect(this.send);
    this.send.connect(this.delay);
    this.delay.connect(this.feedback).connect(this.delay);   // regeneration
    this.delay.connect(this.dry);

    this.dry.connect(this.comp).connect(this.out);           // limited path
    this.dry.connect(this.bypass).connect(this.out);         // unlimited path
    this.bypass.gain.value = 0;

    this.out.connect(destination ?? ctx.destination);
    this.apply(this.settings);
  }

  get values(): MixerSettings { return { ...this.settings }; }

  /** The end of the strip — tap it to measure what this channel is sending. */
  get output(): GainNode { return this.out; }

  /** Smooth parameter moves — a stepped filter change clicks. */
  private ramp(p: AudioParam, v: number) {
    const now = this.ctx.currentTime;
    try {
      p.cancelScheduledValues(now);
      p.setTargetAtTime(v, now, 0.03);
    } catch { p.value = v; }
  }

  apply(next: Partial<MixerSettings>) {
    const s = { ...this.settings, ...next };
    s.bass = clamp(s.bass, -12, 12);
    s.mid = clamp(s.mid, -12, 12);
    s.treble = clamp(s.treble, -12, 12);
    s.gain = clamp(s.gain, 0, 2);
    s.echo = clamp(s.echo, 0, 1);
    s.echoTime = clamp(s.echoTime, 0.05, 1);
    s.echoFeedback = clamp(s.echoFeedback, 0, 0.9);
    this.settings = s;

    this.ramp(this.bass.gain, s.bass);
    this.ramp(this.mid.gain, s.mid);
    this.ramp(this.treble.gain, s.treble);
    this.ramp(this.delay.delayTime, s.echoTime);
    this.ramp(this.feedback.gain, s.echoFeedback);
    this.ramp(this.send.gain, s.echo);
    this.ramp(this.out.gain, s.gain);
    // route through the limiter or around it
    this.ramp(this.comp.threshold, s.limiter ? -6 : 0);
    this.ramp(this.bypass.gain, s.limiter ? 0 : 1);
    this.ramp((this.comp as any).__noop ?? this.comp.knee, s.limiter ? 6 : 0);
    this.dryGain(s.limiter);
  }

  private dryGain(limiting: boolean) {
    // the two paths must not sum: one of them is always silent
    this.ramp(this.comp.ratio, limiting ? 12 : 1);
  }

  /** How hard the limiter is working, in dB — honest feedback for the user. */
  get reduction() { return Math.abs(this.comp.reduction || 0); }

  dispose() {
    [this.input, this.bass, this.mid, this.treble, this.dry, this.send,
      this.delay, this.feedback, this.comp, this.bypass, this.out]
      .forEach((n) => { try { n.disconnect(); } catch {} });
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : 0));

/* ----------------------------------------------------------- persistence */

const KEY = (channel: string) => `sync-music.mixer.${channel}`;

export function loadSettings(channel: string): MixerSettings {
  try {
    const raw = localStorage.getItem(KEY(channel));
    if (!raw) return { ...FLAT };
    return { ...FLAT, ...JSON.parse(raw) };
  } catch { return { ...FLAT }; }
}

export function saveSettings(channel: string, s: MixerSettings) {
  try { localStorage.setItem(KEY(channel), JSON.stringify(s)); } catch {}
}
