/**
 * A real mixer channel, in software — the desk, not a toy.
 *
 * Signal flow (every box is an actual Web Audio node doing actual DSP):
 *
 *   in → [HPF] → [LPF] → [EQ ×6 parametric] → [drive] → [compressor]
 *        → ┬→ dry ──────────────────────────┐
 *          ├→ delay send → delay + feedback ┤
 *          └→ reverb send → convolver ──────┤
 *                                           ↓
 *            [stereo width M/S] → [pan] → ┬→ [limiter] ─┬→ [level] → [master] → out
 *                                         └→ [straight] ┘
 *
 * Exactly ONE of the limiter path and the straight path is open at a time.
 * (Both were open once, so the signal summed with itself and "limiter off"
 * simply meant twice as loud.)
 *
 * Honest limits, because they matter:
 *  - This is a mixer, not a magic loudness button. Gain past 100 % is real
 *    amplification; the limiter stops the clipping that would otherwise turn
 *    loud into ugly. A phone speaker still runs out of air.
 *  - The reverb is a convolution of a SYNTHETIC impulse (shaped noise), not a
 *    recording of a real hall. It sounds like a room; it is not a specific one.
 *  - Drive is waveshaping: it adds harmonics. That is distortion, used on
 *    purpose. Past about 60 it is clearly audible as grit.
 *  - There is no noise gate. A correct one needs sample-level logic in an
 *    AudioWorklet; a fake one built from a compressor would not gate, and a
 *    control that does nothing is worse than no control.
 *  - Nothing here repairs a bad recording or a blown speaker.
 */

/** One parametric EQ band. */
export interface EqBand { f: number; g: number; q: number }

export interface MixerSettings {
  /* ---- classic three, kept so old saved settings still load ---- */
  /** low shelf, dB (−18…+18) — band 1 */
  bass: number;
  /** mid bell, dB (−18…+18) — band 3 */
  mid: number;
  /** high shelf, dB (−18…+18) — band 6 */
  treble: number;

  /* ---- filters ---- */
  /** high-pass corner in Hz; 20 = off. Clears mud and protects small speakers. */
  hpf: number;
  /** low-pass corner in Hz; 20000 = off. */
  lpf: number;

  /* ---- the two free parametric bands and the frequencies of the rest ---- */
  bassF: number; midF: number; midQ: number; trebleF: number;
  /** band 2: low-mid bell */
  b2g: number; b2f: number; b2q: number;
  /** band 4: high-mid bell */
  b4g: number; b4f: number; b4q: number;
  /** band 5: presence bell */
  b5g: number; b5f: number; b5q: number;

  /* ---- colour ---- */
  /** waveshaper drive, 0…100 (0 = clean) */
  drive: number;
  /** how much of the driven signal is blended back, 0…1 */
  driveMix: number;

  /* ---- dynamics ---- */
  compOn: boolean;
  /** dB (−60…0) */
  compThreshold: number;
  /** :1 (1…20) */
  compRatio: number;
  /** seconds (0…0.3) */
  compAttack: number;
  /** seconds (0.01…1) */
  compRelease: number;
  /** dB (0…40) */
  compKnee: number;
  /** make-up gain in dB (0…24) applied after the compressor */
  makeup: number;

  /* ---- space ---- */
  /** echo mix, 0…1 */
  echo: number;
  /** echo time, seconds (0.02…1.5) */
  echoTime: number;
  /** echo feedback, 0…0.9 */
  echoFeedback: number;
  /** reverb mix, 0…1 */
  reverb: number;
  /** reverb size: tail length in seconds (0.3…6) */
  reverbSize: number;
  /** reverb damping, 0…1 — how fast the highs die away */
  reverbDamp: number;

  /* ---- stereo & output ---- */
  /** 0 = mono, 1 = as recorded, 2 = wide */
  width: number;
  /** −1 = left, 0 = centre, +1 = right */
  pan: number;
  /** output level, 0…2 (1 = unity, 2 = +6 dB) */
  gain: number;
  /** brickwall on the way out */
  limiter: boolean;
  /** limiter ceiling in dB (−12…0) */
  ceiling: number;
}

export const FLAT: MixerSettings = {
  bass: 0, mid: 0, treble: 0,
  hpf: 20, lpf: 20000,
  bassF: 160, midF: 1200, midQ: 0.9, trebleF: 3800,
  b2g: 0, b2f: 400, b2q: 1,
  b4g: 0, b4f: 2800, b4q: 1,
  b5g: 0, b5f: 6000, b5q: 1,
  drive: 0, driveMix: 1,
  compOn: false, compThreshold: -18, compRatio: 3, compAttack: 0.01,
  compRelease: 0.25, compKnee: 6, makeup: 0,
  echo: 0, echoTime: 0.25, echoFeedback: 0.3,
  reverb: 0, reverbSize: 1.8, reverbDamp: 0.5,
  width: 1, pan: 0,
  gain: 1, limiter: true, ceiling: -1,
};

export const PRESETS: Record<string, Partial<MixerSettings>> = {
  Flat: FLAT,
  Bass: { bass: 8, b2g: 2, mid: -1, treble: 1, hpf: 25 },
  Vocal: { bass: -3, b2g: -2, mid: 4, b4g: 3, treble: 3, hpf: 90, compOn: true, compThreshold: -20, compRatio: 3, makeup: 4 },
  Speech: { hpf: 120, bass: -6, mid: 5, b4g: 4, treble: 2, compOn: true, compThreshold: -24, compRatio: 4, makeup: 6, echo: 0, reverb: 0 },
  Party: { bass: 7, mid: 0, b5g: 3, treble: 5, width: 1.4, drive: 15, compOn: true, compThreshold: -16, compRatio: 3, makeup: 3 },
  Club: { bass: 9, hpf: 30, b2g: -2, mid: -1, treble: 4, width: 1.3, compOn: true, compThreshold: -14, compRatio: 4, makeup: 4, gain: 1.15 },
  Hall: { reverb: 0.35, reverbSize: 3, reverbDamp: 0.4 },
  Slapback: { echo: 0.25, echoTime: 0.12, echoFeedback: 0.15 },
  Warm: { drive: 25, driveMix: 0.6, treble: -1, b5g: -2, bass: 3 },
  'Phone speaker': { hpf: 170, bass: -4, mid: 3, b4g: 5, treble: 4, compOn: true, compThreshold: -20, compRatio: 5, makeup: 6, limiter: true },
  Loud: { compOn: true, compThreshold: -22, compRatio: 6, compAttack: 0.005, compRelease: 0.15, makeup: 8, gain: 1.2, ceiling: -0.5 },
};

export class MixerChannel {
  readonly input: GainNode;
  /** tap this to draw a spectrum: it sees exactly what leaves the strip */
  readonly analyser: AnalyserNode;

  private hp: BiquadFilterNode;
  private lp: BiquadFilterNode;
  private b1: BiquadFilterNode;   // low shelf  (bass)
  private b2: BiquadFilterNode;   // low-mid bell
  private b3: BiquadFilterNode;   // mid bell   (mid)
  private b4: BiquadFilterNode;   // high-mid bell
  private b5: BiquadFilterNode;   // presence bell
  private b6: BiquadFilterNode;   // high shelf (treble)

  private shaper: WaveShaperNode;
  private driveWet: GainNode;
  private driveDry: GainNode;
  private driveSum: GainNode;

  private comp: DynamicsCompressorNode;
  private compIn: GainNode;
  private compWet: GainNode;
  private compDry: GainNode;
  private makeupGain: GainNode;

  private dry: GainNode;
  private delaySend: GainNode;
  private delay: DelayNode;
  private feedback: GainNode;
  private revSend: GainNode;
  private convolver: ConvolverNode;
  private wetSum: GainNode;

  private splitter: ChannelSplitterNode;
  private merger: ChannelMergerNode;
  private midGain: GainNode;
  /** side = (L−R)/2 · width, added to L and subtracted from R */
  private sideLpos: GainNode;
  private sideLneg: GainNode;
  private sideRpos: GainNode;
  private sideRneg: GainNode;
  private widthOut: GainNode;
  private panner: StereoPannerNode;

  private brick: DynamicsCompressorNode;
  private limited: GainNode;
  private direct: GainNode;
  private out: GainNode;
  private master: GainNode;

  private settings: MixerSettings = { ...FLAT };
  private irKey = '';
  private meterBuf: Float32Array<ArrayBuffer>;

  constructor(private ctx: AudioContext, destination?: AudioNode) {
    const g = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    const bq = (type: BiquadFilterType, f: number, q = 1) => {
      const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; return n;
    };

    this.input = g();
    this.hp = bq('highpass', 20, 0.707);
    this.lp = bq('lowpass', 20000, 0.707);
    this.b1 = bq('lowshelf', FLAT.bassF);
    this.b2 = bq('peaking', FLAT.b2f, FLAT.b2q);
    this.b3 = bq('peaking', FLAT.midF, FLAT.midQ);
    this.b4 = bq('peaking', FLAT.b4f, FLAT.b4q);
    this.b5 = bq('peaking', FLAT.b5f, FLAT.b5q);
    this.b6 = bq('highshelf', FLAT.trebleF);

    // Saturation: a tanh curve. At drive 0 the curve is a straight line, so
    // the node is mathematically transparent and we do not have to bypass it.
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = '2x';
    this.shaper.curve = makeDriveCurve(0);
    this.driveWet = g(1);
    this.driveDry = g(0);
    this.driveSum = g();

    this.compIn = g();
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = FLAT.compThreshold;
    this.comp.ratio.value = FLAT.compRatio;
    this.comp.attack.value = FLAT.compAttack;
    this.comp.release.value = FLAT.compRelease;
    this.comp.knee.value = FLAT.compKnee;
    this.compWet = g(0);          // compressor OFF by default
    this.compDry = g(1);
    this.makeupGain = g(1);

    this.dry = g(1);
    this.delaySend = g(0);
    this.delay = ctx.createDelay(1.5);
    this.delay.delayTime.value = FLAT.echoTime;
    this.feedback = g(FLAT.echoFeedback);
    this.revSend = g(0);
    this.convolver = ctx.createConvolver();
    this.convolver.normalize = true;
    this.wetSum = g(1);

    // Stereo width by mid/side. mid = (L+R)/2 stays put, side = (L−R)/2 is
    // scaled: 0 collapses to mono, 2 pushes the stereo image out.
    this.splitter = ctx.createChannelSplitter(2);
    this.merger = ctx.createChannelMerger(2);
    this.midGain = g(0.5);
    this.sideLpos = g(0.5);
    this.sideLneg = g(-0.5);
    this.sideRpos = g(0.5);
    this.sideRneg = g(-0.5);
    this.widthOut = g();
    this.panner = ctx.createStereoPanner();

    this.brick = ctx.createDynamicsCompressor();
    this.brick.threshold.value = FLAT.ceiling;
    this.brick.knee.value = 0;
    this.brick.ratio.value = 20;
    this.brick.attack.value = 0.002;
    this.brick.release.value = 0.1;

    this.limited = g(1);
    this.direct = g(0);
    this.out = g(1);
    this.master = g(1);

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.75;
    this.meterBuf = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));

    /* ------------------------------ wiring ------------------------------ */
    this.input.connect(this.hp).connect(this.lp)
      .connect(this.b1).connect(this.b2).connect(this.b3)
      .connect(this.b4).connect(this.b5).connect(this.b6);

    this.b6.connect(this.shaper).connect(this.driveWet).connect(this.driveSum);
    this.b6.connect(this.driveDry).connect(this.driveSum);

    this.driveSum.connect(this.compIn);
    this.compIn.connect(this.comp).connect(this.compWet).connect(this.makeupGain);
    this.compIn.connect(this.compDry).connect(this.makeupGain);

    this.makeupGain.connect(this.dry).connect(this.wetSum);
    this.makeupGain.connect(this.delaySend).connect(this.delay);
    this.delay.connect(this.feedback).connect(this.delay);     // regeneration
    this.delay.connect(this.wetSum);
    this.makeupGain.connect(this.revSend).connect(this.convolver).connect(this.wetSum);

    this.wetSum.connect(this.splitter);
    // mid = (L+R)/2 goes to both outputs unchanged
    this.splitter.connect(this.midGain, 0);
    this.splitter.connect(this.midGain, 1);
    this.midGain.connect(this.merger, 0, 0);
    this.midGain.connect(this.merger, 0, 1);
    // side = (L−R)/2·width: added to the left, subtracted from the right
    this.splitter.connect(this.sideLpos, 0);
    this.splitter.connect(this.sideLneg, 1);
    this.sideLpos.connect(this.merger, 0, 0);
    this.sideLneg.connect(this.merger, 0, 0);
    this.splitter.connect(this.sideRneg, 0);
    this.splitter.connect(this.sideRpos, 1);
    this.sideRneg.connect(this.merger, 0, 1);
    this.sideRpos.connect(this.merger, 0, 1);
    this.merger.connect(this.widthOut).connect(this.panner);

    this.panner.connect(this.brick).connect(this.limited).connect(this.out);
    this.panner.connect(this.direct).connect(this.out);

    this.out.connect(this.master).connect(destination ?? ctx.destination);
    this.out.connect(this.analyser);

    this.setImpulse(FLAT.reverbSize, FLAT.reverbDamp);
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
    const s = { ...this.settings, ...next } as MixerSettings;

    s.bass = clamp(s.bass, -18, 18);
    s.mid = clamp(s.mid, -18, 18);
    s.treble = clamp(s.treble, -18, 18);
    s.b2g = clamp(s.b2g, -18, 18);
    s.b4g = clamp(s.b4g, -18, 18);
    s.b5g = clamp(s.b5g, -18, 18);
    s.hpf = clamp(s.hpf, 20, 800);
    s.lpf = clamp(s.lpf, 1000, 20000);
    s.bassF = clamp(s.bassF, 40, 400);
    s.midF = clamp(s.midF, 200, 5000);
    s.midQ = clamp(s.midQ, 0.2, 8);
    s.trebleF = clamp(s.trebleF, 1500, 12000);
    s.b2f = clamp(s.b2f, 80, 1000); s.b2q = clamp(s.b2q, 0.2, 8);
    s.b4f = clamp(s.b4f, 800, 8000); s.b4q = clamp(s.b4q, 0.2, 8);
    s.b5f = clamp(s.b5f, 2000, 16000); s.b5q = clamp(s.b5q, 0.2, 8);
    s.drive = clamp(s.drive, 0, 100);
    s.driveMix = clamp(s.driveMix, 0, 1);
    s.compThreshold = clamp(s.compThreshold, -60, 0);
    s.compRatio = clamp(s.compRatio, 1, 20);
    s.compAttack = clamp(s.compAttack, 0, 0.3);
    s.compRelease = clamp(s.compRelease, 0.01, 1);
    s.compKnee = clamp(s.compKnee, 0, 40);
    s.makeup = clamp(s.makeup, 0, 24);
    s.echo = clamp(s.echo, 0, 1);
    s.echoTime = clamp(s.echoTime, 0.02, 1.5);
    s.echoFeedback = clamp(s.echoFeedback, 0, 0.9);
    s.reverb = clamp(s.reverb, 0, 1);
    s.reverbSize = clamp(s.reverbSize, 0.3, 6);
    s.reverbDamp = clamp(s.reverbDamp, 0, 1);
    s.width = clamp(s.width, 0, 2);
    s.pan = clamp(s.pan, -1, 1);
    s.gain = clamp(s.gain, 0, 2);
    s.ceiling = clamp(s.ceiling, -12, 0);

    this.settings = s;

    this.ramp(this.hp.frequency, s.hpf);
    this.ramp(this.lp.frequency, s.lpf);
    this.ramp(this.b1.gain, s.bass); this.ramp(this.b1.frequency, s.bassF);
    this.ramp(this.b2.gain, s.b2g); this.ramp(this.b2.frequency, s.b2f); this.ramp(this.b2.Q, s.b2q);
    this.ramp(this.b3.gain, s.mid); this.ramp(this.b3.frequency, s.midF); this.ramp(this.b3.Q, s.midQ);
    this.ramp(this.b4.gain, s.b4g); this.ramp(this.b4.frequency, s.b4f); this.ramp(this.b4.Q, s.b4q);
    this.ramp(this.b5.gain, s.b5g); this.ramp(this.b5.frequency, s.b5f); this.ramp(this.b5.Q, s.b5q);
    this.ramp(this.b6.gain, s.treble); this.ramp(this.b6.frequency, s.trebleF);

    if (this.curveDrive !== s.drive) {
      this.shaper.curve = makeDriveCurve(s.drive);
      this.curveDrive = s.drive;
    }
    const dmix = s.drive > 0 ? s.driveMix : 1;
    this.ramp(this.driveWet.gain, dmix);
    this.ramp(this.driveDry.gain, 1 - dmix);

    this.ramp(this.comp.threshold, s.compThreshold);
    this.ramp(this.comp.ratio, s.compRatio);
    this.ramp(this.comp.attack, s.compAttack);
    this.ramp(this.comp.release, s.compRelease);
    this.ramp(this.comp.knee, s.compKnee);
    this.ramp(this.compWet.gain, s.compOn ? 1 : 0);
    this.ramp(this.compDry.gain, s.compOn ? 0 : 1);
    this.ramp(this.makeupGain.gain, dbToGain(s.compOn ? s.makeup : 0));

    this.ramp(this.delay.delayTime, s.echoTime);
    this.ramp(this.feedback.gain, s.echoFeedback);
    this.ramp(this.delaySend.gain, s.echo);
    this.ramp(this.revSend.gain, s.reverb);
    const key = `${s.reverbSize.toFixed(2)}/${s.reverbDamp.toFixed(2)}`;
    if (key !== this.irKey) this.setImpulse(s.reverbSize, s.reverbDamp);

    // mid/side: mid stays at 0.5, side is scaled by the width control
    this.ramp(this.midGain.gain, 0.5);
    this.ramp(this.sideLpos.gain, 0.5 * s.width);
    this.ramp(this.sideLneg.gain, -0.5 * s.width);
    this.ramp(this.sideRpos.gain, 0.5 * s.width);
    this.ramp(this.sideRneg.gain, -0.5 * s.width);
    this.panner.pan.value = s.pan;

    this.ramp(this.brick.threshold, s.ceiling);
    this.ramp(this.limited.gain, s.limiter ? 1 : 0);
    this.ramp(this.direct.gain, s.limiter ? 0 : 1);
    this.ramp(this.out.gain, s.gain);
  }

  private curveDrive = -1;

  /**
   * Build the reverb's impulse response: shaped noise with an exponential
   * decay, low-passed more and more over its length so the tail darkens the
   * way a real room does. Synthetic and honest about it.
   */
  private setImpulse(seconds: number, damp: number) {
    const sr = this.ctx.sampleRate;
    const len = Math.max(1, Math.floor(sr * seconds));
    const ir = this.ctx.createBuffer(2, len, sr);
    const decay = 2 + damp * 5;
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let last = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const env = Math.pow(1 - t, decay);
        // one-pole low pass that closes as the tail dies: the highs go first
        const a = 0.2 + 0.75 * (1 - damp) * (1 - t);
        last = last * (1 - a) + (Math.random() * 2 - 1) * a;
        d[i] = last * env;
      }
    }
    this.convolver.buffer = ir;
    this.irKey = `${seconds.toFixed(2)}/${damp.toFixed(2)}`;
  }

  /** The phone's own volume / mute for this strip, separate from the mixer's level. */
  setMaster(v: number) { this.ramp(this.master.gain, clamp(v, 0, 1)); }

  /** How hard the compressor is working, in dB — honest feedback for the user. */
  get reduction() { return Math.abs(Number(this.comp.reduction) || 0); }
  /** How hard the output limiter is working, in dB. */
  get ceilingReduction() { return Math.abs(Number(this.brick.reduction) || 0); }

  /** Live peak and RMS of what this strip is sending, in dBFS. */
  levels(): { peak: number; rms: number } {
    this.analyser.getFloatTimeDomainData(this.meterBuf);
    let peak = 0; let sum = 0;
    for (let i = 0; i < this.meterBuf.length; i++) {
      const v = this.meterBuf[i];
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.meterBuf.length);
    return { peak: toDb(peak), rms: toDb(rms) };
  }

  /** Spectrum for the display, in dBFS per bin. */
  spectrum(into?: Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer> {
    const buf = into && into.length === this.analyser.frequencyBinCount
      ? into : new Float32Array(new ArrayBuffer(this.analyser.frequencyBinCount * 4));
    this.analyser.getFloatFrequencyData(buf);
    return buf;
  }

  dispose() {
    [this.input, this.hp, this.lp, this.b1, this.b2, this.b3, this.b4, this.b5, this.b6,
      this.shaper, this.driveWet, this.driveDry, this.driveSum,
      this.compIn, this.comp, this.compWet, this.compDry, this.makeupGain,
      this.dry, this.delaySend, this.delay, this.feedback, this.revSend, this.convolver,
      this.wetSum, this.splitter, this.merger, this.midGain,
      this.sideLpos, this.sideLneg, this.sideRpos, this.sideRneg, this.widthOut, this.panner, this.brick, this.limited, this.direct,
      this.out, this.master, this.analyser]
      .forEach((n) => { try { n?.disconnect(); } catch {} });
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : 0));
const dbToGain = (db: number) => Math.pow(10, db / 20);
const toDb = (v: number) => (v > 0 ? 20 * Math.log10(v) : -120);

/**
 * tanh-style saturation curve. `drive` 0 gives a straight line (no change at
 * all), so the node can stay in the chain permanently without colouring a
 * clean signal.
 */
function makeDriveCurve(drive: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  const k = drive / 100 * 25;        // 0 … 25
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    curve[i] = k === 0 ? x : Math.tanh(k * x) / Math.tanh(k);
  }
  return curve;
}

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
