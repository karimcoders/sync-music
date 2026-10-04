import { useCallback, useEffect, useRef, useState } from 'react';
import { AppBar, Button, Card, Row, Shell, Stack } from '../ui';

/**
 * Sound Check — a phone-based diagnostic toolkit.
 *
 * Everything here is measured with the phone's own microphone through the Web
 * Audio API. Be clear about what that is and is not:
 *
 *   • The dB readout is RELATIVE (dBFS referenced to the mic input), not a
 *     calibrated SPL meter. A real SPL figure needs a calibrated microphone.
 *   • Android applies its own gain control, noise suppression and high-pass
 *     filtering to the mic, so the low end especially is approximate.
 *   • Use it for comparisons (before/after a change, position A vs B, left vs
 *     right speaker), which is exactly where it is reliable.
 */

type Band = { f: number; db: number };

const BANDS = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

function dbColor(db: number) {
  if (db > -12) return '#f87171';
  if (db > -30) return '#4ade80';
  if (db > -55) return '#facc15';
  return '#64748b';
}

export default function SoundCheck({ go }: { go: (p: string) => void }) {
  const [on, setOn] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [level, setLevel] = useState(-100);      // current RMS, dBFS
  const [peak, setPeak] = useState(-100);        // peak hold
  const [avg, setAvg] = useState(-100);
  const [clipping, setClipping] = useState(false);
  const [bands, setBands] = useState<Band[]>(BANDS.map((f) => ({ f, db: -100 })));
  const [hum, setHum] = useState<{ h50: number; h60: number; h100: number } | null>(null);
  const [tone, setTone] = useState<number | null>(null);
  const [sweep, setSweep] = useState<{ running: boolean; curve: Band[] }>({ running: false, curve: [] });
  const [snapA, setSnapA] = useState<Band[] | null>(null);
  const [snapB, setSnapB] = useState<Band[] | null>(null);
  const [dominant, setDominant] = useState<number | null>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const anRef = useRef<AnalyserNode | null>(null);
  // NB: keep the source node alive. A MediaStreamAudioSourceNode that nothing
  // references and that does not reach the destination gets collected, and the
  // analyser then reports pure silence for ever.
  const srcRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const sinkRef = useRef<GainNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const oscRef = useRef<OscillatorNode | null>(null);
  const rafRef = useRef(0);
  const avgRef = useRef<number[]>([]);

  const stop = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    oscRef.current?.stop();
    oscRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    try { srcRef.current?.disconnect(); sinkRef.current?.disconnect(); } catch {}
    srcRef.current = null;
    sinkRef.current = null;
    void ctxRef.current?.close();
    ctxRef.current = null;
    anRef.current = null;
    setOn(false);
    setTone(null);
  }, []);

  useEffect(() => () => stop(), [stop]);

  const start = async () => {
    setErr(null);
    try {
      // Raw-ish input: the browser's cleanup (AGC, noise suppression, the
      // echo canceller's high-pass) would hide exactly the problems we are
      // looking for. Some devices reject that combination, so fall back to a
      // plain request rather than failing.
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      streamRef.current = stream;
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      ctxRef.current = ctx;
      // Mobile browsers hand back a suspended context; without this the
      // analyser just reports silence forever.
      if (ctx.state !== 'running') await ctx.resume();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 8192;
      an.smoothingTimeConstant = 0.6;
      src.connect(an);
      // a silent sink keeps the graph referenced without making a sound
      const sink = ctx.createGain();
      sink.gain.value = 0;
      an.connect(sink).connect(ctx.destination);
      srcRef.current = src;
      sinkRef.current = sink;
      anRef.current = an;
      setOn(true);
      loop();
    } catch {
      setErr('Could not open the microphone. Allow mic access for this site, then try again.');
    }
  };

  const loop = () => {
    const an = anRef.current;
    const ctx = ctxRef.current;
    if (!an || !ctx) return;
    const freq = new Float32Array(an.frequencyBinCount);
    const time = new Float32Array(an.fftSize);

    const tick = () => {
      an.getFloatFrequencyData(freq);
      an.getFloatTimeDomainData(time);

      // level: RMS of the time-domain window, in dBFS
      let sum = 0;
      let max = 0;
      for (let i = 0; i < time.length; i++) {
        sum += time[i] * time[i];
        max = Math.max(max, Math.abs(time[i]));
      }
      const rms = Math.sqrt(sum / time.length);
      const db = 20 * Math.log10(rms || 1e-7);
      setLevel(db);
      setClipping(max > 0.98);
      setPeak((p) => Math.max(p, db));
      avgRef.current.push(db);
      if (avgRef.current.length > 120) avgRef.current.shift();
      setAvg(avgRef.current.reduce((a, b) => a + b, 0) / avgRef.current.length);

      const binHz = ctx.sampleRate / an.fftSize;
      const at = (f: number) => {
        const i = Math.round(f / binHz);
        return freq[Math.min(freq.length - 1, Math.max(0, i))] ?? -100;
      };
      // octave bands: average the bins inside each band
      const next: Band[] = BANDS.map((f) => {
        const lo = Math.max(1, Math.round((f / Math.SQRT2) / binHz));
        const hi = Math.min(freq.length - 1, Math.round((f * Math.SQRT2) / binHz));
        let acc = 0;
        let n = 0;
        for (let i = lo; i <= hi; i++) { acc += freq[i]; n++; }
        return { f, db: n ? acc / n : -100 };
      });
      setBands(next);
      setHum({ h50: at(50), h60: at(60), h100: at(100) });

      // dominant frequency — what a feedback ring would sit on
      let bi = 0;
      for (let i = 1; i < freq.length; i++) if (freq[i] > freq[bi]) bi = i;
      setDominant(freq[bi] > -45 ? Math.round(bi * binHz) : null);

      rafRef.current = requestAnimationFrame(tick);
    };
    tick();
  };

  /** Play a steady test tone out of this phone's speaker. */
  const playTone = (f: number | null) => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    oscRef.current?.stop();
    oscRef.current = null;
    setTone(f);
    if (f == null) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.25;
    osc.frequency.value = f;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    oscRef.current = osc;
  };

  /** 20 Hz → 16 kHz sweep, recording what the mic hears at each step. */
  const runSweep = async () => {
    const ctx = ctxRef.current;
    const an = anRef.current;
    if (!ctx || !an) return;
    setSweep({ running: true, curve: [] });
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.25;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    const curve: Band[] = [];
    const freq = new Float32Array(an.frequencyBinCount);
    const binHz = ctx.sampleRate / an.fftSize;
    for (const f of [31, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800,
      1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000]) {
      osc.frequency.setValueAtTime(f, ctx.currentTime);
      await new Promise((r) => setTimeout(r, 180));
      an.getFloatFrequencyData(freq);
      const i = Math.round(f / binHz);
      let m = -120;
      for (let k = Math.max(0, i - 2); k <= Math.min(freq.length - 1, i + 2); k++) m = Math.max(m, freq[k]);
      curve.push({ f, db: m });
      setSweep({ running: true, curve: [...curve] });
    }
    osc.stop();
    setSweep({ running: false, curve });
  };

  const bar = (db: number) => Math.max(0, Math.min(100, (db + 90) * 1.25));

  /* --------------------------- plain-language read ------------------------ */
  const notes: string[] = [];
  if (on) {
    const b = (f: number) => bands.find((x) => x.f === f)?.db ?? -100;
    const low = (b(63) + b(125)) / 2;
    const mid = (b(500) + b(1000)) / 2;
    const high = (b(4000) + b(8000)) / 2;
    if (level < -60) notes.push('Almost nothing is reaching the mic — is the music playing, and is the phone near the speakers?');
    if (clipping) notes.push('The input is clipping. Lower the source or move the phone back; this reading is not trustworthy while it clips.');
    if (low - mid > 9) notes.push('Low frequencies dominate: boomy. Try less bass, or move the speaker away from the wall or corner.');
    if (mid - low > 12) notes.push('Very little low end here — either the speaker is small or this spot is in a bass null. Walk a metre and measure again.');
    if (high - mid > 9) notes.push('Treble-heavy and likely harsh at the back of the room.');
    if (mid - high > 14) notes.push('Dull: high frequencies are missing. Point the speakers towards the audience, not over their heads.');
    if (hum && hum.h50 > -45) notes.push('A strong 50 Hz tone is present — that is mains hum. Check the cable, the ground, and keep audio cables away from power leads.');
    if (dominant && level > -35 && dominant > 700 && dominant < 6000) notes.push(`One narrow tone around ${dominant} Hz dominates — that is what feedback sounds like. Lower the mic gain or move the mic behind the speakers.`);
    if (!notes.length) notes.push('Nothing alarming: level is sensible and the balance looks even for a phone measurement.');
  }

  const compare = snapA && snapB
    ? BANDS.map((f) => {
      const a = snapA.find((x) => x.f === f)?.db ?? -100;
      const b = snapB.find((x) => x.f === f)?.db ?? -100;
      return { f, d: b - a };
    })
    : null;

  return (
    <Shell tab="sound" go={go}>
      <AppBar title="Sound check" sub="Mic tools" />

      <Card>
        <Stack gap={12}>
          <h1 style={{ margin: 0 }}>Measure the room with this phone</h1>
          <p className="dim" style={{ margin: 0 }}>
            Mic level, spectrum, hum, clipping and a speaker sweep. These are honest,
            <b> relative </b> measurements from a phone microphone — great for comparing
            before/after and spot A vs spot B, not a replacement for a calibrated SPL meter.
          </p>
          {!on
            ? <Button testId="mic-start" onClick={() => void start()}>START MIC</Button>
            : <Button variant="danger" testId="mic-stop" onClick={stop}>STOP</Button>}
          {err && <div className="err-text">{err}</div>}
        </Stack>
      </Card>

      {on && (
        <>
          <Card>
            <Row>
              <div className="kicker">Level (relative, dBFS)</div>
              {clipping && <span className="err-text">CLIPPING</span>}
            </Row>
            <div className="big-number" data-testid="level">{level.toFixed(1)}</div>
            <div className="meter"><i className="pos" style={{ width: `${bar(level)}%`, background: dbColor(level) }} /></div>
            <Row style={{ marginTop: 8 }}>
              <span className="dim mono">peak <b data-testid="peak">{peak.toFixed(1)}</b></span>
              <span className="dim mono">avg {avg.toFixed(1)}</span>
              <button className="chip" onClick={() => { setPeak(-100); avgRef.current = []; }}>Reset</button>
            </Row>
          </Card>

          <Card>
            <div className="kicker">Spectrum — octave bands</div>
            <div className="spectrum">
              {bands.map((b) => (
                <div className="spec-col" key={b.f}>
                  <i style={{ height: `${bar(b.db)}%`, background: dbColor(b.db) }} />
                  <span>{b.f >= 1000 ? `${b.f / 1000}k` : b.f}</span>
                </div>
              ))}
            </div>
            <Row style={{ marginTop: 10 }}>
              <button className="chip" onClick={() => setSnapA(bands)}>Save as A</button>
              <button className="chip" onClick={() => setSnapB(bands)}>Save as B</button>
              {(snapA || snapB) && <button className="chip" onClick={() => { setSnapA(null); setSnapB(null); }}>Clear</button>}
            </Row>
            {compare && (
              <div className="list" style={{ marginTop: 10 }}>
                <div className="tiny">B compared with A (positive = louder in B)</div>
                {compare.map((c) => (
                  <div className="list-item" key={c.f}>
                    <span className="grow mono">{c.f >= 1000 ? `${c.f / 1000}k` : c.f} Hz</span>
                    <span className="mono" style={{ color: c.d > 0 ? 'var(--ok)' : 'var(--warn)' }}>
                      {c.d > 0 ? '+' : ''}{c.d.toFixed(1)} dB
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <div className="kicker">Hum &amp; noise</div>
            <div className="list">
              {hum && ([['50 Hz (mains)', hum.h50], ['60 Hz (mains)', hum.h60], ['100 Hz (harmonic)', hum.h100]] as const).map(([label, v]) => (
                <div className="list-item" key={label}>
                  <span className="grow">{label}</span>
                  <span className="mono" style={{ color: v > -45 ? 'var(--warn)' : 'var(--ok)' }}>{v.toFixed(0)} dB</span>
                </div>
              ))}
            </div>
            <div className="tiny" style={{ marginTop: 8 }}>
              Dominant tone right now: {dominant ? `${dominant} Hz` : '—'}
            </div>
          </Card>

          <Card>
            <div className="kicker">Test tones from this phone</div>
            <div className="chip-row" style={{ marginTop: 8 }}>
              {[40, 60, 80, 100, 440, 1000, 4000].map((f) => (
                <button key={f} className={`chip ${tone === f ? 'active' : ''}`} onClick={() => playTone(tone === f ? null : f)}>
                  {f} Hz
                </button>
              ))}
              {tone != null && <button className="chip" onClick={() => playTone(null)}>Stop tone</button>}
            </div>
            <div style={{ height: 12 }} />
            <Button variant="ghost" disabled={sweep.running} onClick={() => void runSweep()}>
              {sweep.running ? 'SWEEPING…' : 'RUN 31 Hz → 16 kHz SWEEP'}
            </Button>
            {!!sweep.curve.length && (
              <div className="spectrum tall" style={{ marginTop: 12 }}>
                {sweep.curve.map((c) => (
                  <div className="spec-col" key={c.f}>
                    <i style={{ height: `${bar(c.db)}%`, background: dbColor(c.db) }} />
                  </div>
                ))}
              </div>
            )}
            {!!sweep.curve.length && (
              <div className="tiny" style={{ marginTop: 6 }}>
                Left is 31 Hz, right is 16 kHz. Dips are the room and the speaker together —
                move a metre and run it again before blaming the box.
              </div>
            )}
          </Card>

          <Card>
            <div className="kicker">What this means</div>
            <ul className="tips">{notes.map((n) => <li key={n}>{n}</li>)}</ul>
          </Card>
        </>
      )}

      <button className="chip" style={{ alignSelf: 'center' }} onClick={() => go('/')}>← Home</button>
      <div className="footer-note">
        Phone-based, relative measurements · build {__BUILD__}
      </div>
    </Shell>
  );
}
