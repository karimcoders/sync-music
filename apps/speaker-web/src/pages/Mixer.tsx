import { useEffect, useRef, useState } from 'react';
import { AppBar, Button, Card, Row, Shell, Stack, useMood } from '../ui';
import { FLAT, PRESETS, type MixerSettings } from '../lib/audio/mixer';
import { getSpeaker } from '../lib/p2p/speakerSingleton';
import { getHost } from '../lib/p2p/hostSingleton';

type Chan = 'music' | 'voice';

/**
 * The mixing desk.
 *
 * Two channel strips, because a voice and a song want opposite treatment,
 * and both are live: every move is heard immediately on THIS phone. Settings
 * are remembered per phone, so the one with the tinny speaker can keep its
 * own curve.
 */
export default function Mixer({ go }: { go: (p: string) => void }) {
  const client = getSpeaker();
  // If this device is also running the host, this is the ROOM's desk: a move
  // here must be heard on every speaker, not only in the engineer's own hand.
  // The host lives in hostSingleton, so it is still here after a tab switch.
  const host = getHost() as any;
  const isDesk = !!host && typeof host.setRoomMix === 'function';
  const [roomWide, setRoomWide] = useState(true);
  const toRoom = (patch: Partial<MixerSettings>) => {
    if (isDesk && roomWide) host.setRoomMix(chan, patch as Record<string, number | boolean>);
  };
  const [, repaint] = useState(0);
  const [chan, setChan] = useState<Chan>('music');
  const following = !!client && !isDesk && client.followsHost;
  const [sect, setSect] = useState<'eq' | 'dyn' | 'space' | 'fx' | 'out'>('eq');
  const [vals, setVals] = useState<MixerSettings>(() => client?.mixOf('music') ?? { ...FLAT });
  const [reduction, setReduction] = useState(0);

  useMood('connected');

  // follow the running speaker (it keeps running while this page is open)
  // When the host moves a slider the sliders here move with it.
  useEffect(() => client?.subscribe(() => {
    repaint((n) => n + 1);
    const next = client.mixOf(chan);
    setVals((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }), [client, chan]);

  useEffect(() => { setVals(client?.mixOf(chan) ?? { ...FLAT }); }, [chan, client]);

  // how hard the limiter is working — honest feedback that you are pushing it
  useEffect(() => {
    const t = window.setInterval(() => {
      const m = chan === 'music' ? client?.mixers.music : client?.mixers.voice;
      setReduction(m ? Math.round(m.reduction) : 0);
    }, 300);
    return () => window.clearInterval(t);
  }, [chan, client]);

  // A speaker phone that moves a slider by hand is choosing its OWN sound; say
  // so, instead of letting the host's next move silently undo it.
  const local = (patch: Partial<MixerSettings>) => {
    if (client && !isDesk && client.followsHost) client.setFollowHost(false);
    client?.setMix(chan, patch);
  };
  const set = (patch: Partial<MixerSettings>) => {
    const next = { ...vals, ...patch };
    setVals(next);
    local(patch);
    toRoom(patch);
  };

  const live = !!client?.isAudioEnabled;

  return (
    <Shell tab="mixer" go={go}>
      <AppBar title="Mixer" sub={isDesk && roomWide ? 'Every speaker' : 'This phone'} />
      {isDesk && (
        <Card>
          <Row>
            <div>
              <div className="kicker">Where these controls apply</div>
              <div className="tiny" style={{ marginTop: 4 }}>
                {roomWide
                  ? 'Every connected speaker, and this phone.'
                  : 'Only this phone. The speakers keep their own sound.'}
              </div>
            </div>
            <button className="chip" data-testid="mix-scope" onClick={() => setRoomWide(!roomWide)}>
              {roomWide ? 'All speakers' : 'This phone'}
            </button>
          </Row>
        </Card>
      )}

      {client && !isDesk && (
        <Card>
          <Row>
            <div>
              <div className="kicker">Whose sound is this?</div>
              <div className="tiny" style={{ marginTop: 4 }}>
                {following
                  ? 'This phone follows the host’s mixer. Move a slider and it keeps its own sound instead.'
                  : 'This phone keeps its own sound. The host’s mixer is ignored here.'}
              </div>
            </div>
            <button className="chip" data-testid="mix-follow" onClick={() => client.setFollowHost(!client.followsHost)}>
              {following ? 'Following host' : 'My own mix'}
            </button>
          </Row>
        </Card>
      )}

      <Card>
        <Row>
          <div className="seg">
            <button className={chan === 'music' ? 'on' : ''} data-testid="chan-music" onClick={() => setChan('music')}>MUSIC</button>
            <button className={chan === 'voice' ? 'on' : ''} data-testid="chan-voice" onClick={() => setChan('voice')}>VOICE</button>
          </div>
          <span className="tiny dim">{chan === 'music' ? 'the song' : "the host's mic"}</span>
        </Row>

        {!client && (
          <div style={{ marginTop: 10 }}>
            <p className="tiny" style={{ margin: '0 0 8px' }}>
              This phone is not in a room, so there is nothing to mix yet. Open
              <b> Speaker</b>, join the host and tap once to start — the sliders
              stay live while you switch tabs. What you set here is saved and
              applied as soon as the sound starts.
            </p>
            <Button variant="ghost" onClick={() => go('/speaker')}>GO TO SPEAKER</Button>
          </div>
        )}
        {client && !live && (
          <p className="tiny" style={{ marginTop: 10 }}>
            Tap <b>anywhere to start</b> on the Speaker tab first — the sliders
            are saved now and applied the moment this phone starts playing.
          </p>
        )}
        {client && live && chan === 'voice' && !client.mixers.voice && (
          <p className="tiny" style={{ marginTop: 10 }}>
            The host’s microphone is off, so the voice strip appears when it is
            switched on. Your settings are saved and will be used then.
          </p>
        )}

        <Spectrum client={client} chan={chan} />
        <Levels client={client} chan={chan} />
      </Card>

      <Card>
        <div className="seg" style={{ marginBottom: 12 }}>
          {(['eq', 'dyn', 'space', 'fx', 'out'] as const).map((k) => (
            <button key={k} className={sect === k ? 'on' : ''} data-testid={`sect-${k}`} onClick={() => setSect(k)}>
              {k === 'eq' ? 'EQ' : k === 'dyn' ? 'DYNAMICS' : k === 'space' ? 'SPACE' : k === 'fx' ? '3D / FX' : 'OUT'}
            </button>
          ))}
        </div>

        {sect === 'eq' && (
          <Stack gap={4}>
            <div className="kicker">Filters</div>
            <Knob label="High-pass" unit="Hz" min={20} max={800} step={5} value={Math.round(vals.hpf)}
                  onChange={(v) => set({ hpf: v })} testId="hpf" />
            <Knob label="Low-pass" unit="Hz" min={1000} max={20000} step={100} value={Math.round(vals.lpf)}
                  onChange={(v) => set({ lpf: v })} testId="lpf" />

            <div className="kicker" style={{ marginTop: 10 }}>6-band parametric EQ</div>
            <Knob label="1 · Bass (shelf)" unit="dB" min={-18} max={18} step={0.5} value={vals.bass}
                  onChange={(v) => set({ bass: v })} testId="bass" />
            <Knob label="1 · Bass freq" unit="Hz" min={40} max={400} step={5} value={Math.round(vals.bassF)}
                  onChange={(v) => set({ bassF: v })} testId="bass-f" />
            <Knob label="2 · Low-mid" unit="dB" min={-18} max={18} step={0.5} value={vals.b2g}
                  onChange={(v) => set({ b2g: v })} testId="b2g" />
            <Knob label="2 · Low-mid freq" unit="Hz" min={80} max={1000} step={10} value={Math.round(vals.b2f)}
                  onChange={(v) => set({ b2f: v })} testId="b2f" />
            <Knob label="3 · Mid" unit="dB" min={-18} max={18} step={0.5} value={vals.mid}
                  onChange={(v) => set({ mid: v })} testId="mid" />
            <Knob label="3 · Mid freq" unit="Hz" min={200} max={5000} step={25} value={Math.round(vals.midF)}
                  onChange={(v) => set({ midF: v })} testId="mid-f" />
            <Knob label="3 · Mid width (Q)" unit="" min={0.2} max={8} step={0.1} value={vals.midQ}
                  onChange={(v) => set({ midQ: v })} testId="mid-q" />
            <Knob label="4 · High-mid" unit="dB" min={-18} max={18} step={0.5} value={vals.b4g}
                  onChange={(v) => set({ b4g: v })} testId="b4g" />
            <Knob label="4 · High-mid freq" unit="Hz" min={800} max={8000} step={50} value={Math.round(vals.b4f)}
                  onChange={(v) => set({ b4f: v })} testId="b4f" />
            <Knob label="5 · Presence" unit="dB" min={-18} max={18} step={0.5} value={vals.b5g}
                  onChange={(v) => set({ b5g: v })} testId="b5g" />
            <Knob label="5 · Presence freq" unit="Hz" min={2000} max={16000} step={100} value={Math.round(vals.b5f)}
                  onChange={(v) => set({ b5f: v })} testId="b5f" />
            <Knob label="6 · Treble (shelf)" unit="dB" min={-18} max={18} step={0.5} value={vals.treble}
                  onChange={(v) => set({ treble: v })} testId="treble" />
            <Knob label="6 · Treble freq" unit="Hz" min={1500} max={12000} step={100} value={Math.round(vals.trebleF)}
                  onChange={(v) => set({ trebleF: v })} testId="treble-f" />
          </Stack>
        )}

        {sect === 'dyn' && (
          <Stack gap={4}>
            <Row>
              <div>
                <div className="kicker">Compressor</div>
                <div className="tiny dim">Evens out loud and quiet — then make it up with gain</div>
              </div>
              <button className={`chip ${vals.compOn ? 'active' : ''}`} data-testid="comp-on"
                      onClick={() => set({ compOn: !vals.compOn })}>{vals.compOn ? 'On' : 'Off'}</button>
            </Row>
            <Knob label="Threshold" unit="dB" min={-60} max={0} step={1} value={Math.round(vals.compThreshold)}
                  onChange={(v) => set({ compThreshold: v })} testId="comp-threshold" />
            <Knob label="Ratio" unit=":1" min={1} max={20} step={0.5} value={vals.compRatio}
                  onChange={(v) => set({ compRatio: v })} testId="comp-ratio" />
            <Knob label="Attack" unit="ms" min={0} max={300} step={1} value={Math.round(vals.compAttack * 1000)}
                  onChange={(v) => set({ compAttack: v / 1000 })} testId="comp-attack" />
            <Knob label="Release" unit="ms" min={10} max={1000} step={10} value={Math.round(vals.compRelease * 1000)}
                  onChange={(v) => set({ compRelease: v / 1000 })} testId="comp-release" />
            <Knob label="Knee" unit="dB" min={0} max={40} step={1} value={Math.round(vals.compKnee)}
                  onChange={(v) => set({ compKnee: v })} testId="comp-knee" />
            <Knob label="Make-up gain" unit="dB" min={0} max={24} step={0.5} value={vals.makeup}
                  onChange={(v) => set({ makeup: v })} testId="comp-makeup" />
            <div className="tiny" data-testid="reduction" style={{ marginTop: 6 }}>
              {reduction > 0.5
                ? `Compressor is holding back ${reduction} dB right now.`
                : 'Compressor is not working on the signal at the moment.'}
            </div>

            <div className="kicker" style={{ marginTop: 12 }}>Drive (saturation)</div>
            <Knob label="Drive" unit="%" min={0} max={100} step={1} value={Math.round(vals.drive)}
                  onChange={(v) => set({ drive: v })} testId="drive" />
            <Knob label="Blend" unit="%" min={0} max={100} step={1} value={Math.round(vals.driveMix * 100)}
                  onChange={(v) => set({ driveMix: v / 100 })} testId="drive-mix" />
            <p className="tiny" style={{ margin: '6px 0 0' }}>
              Drive adds harmonics on purpose — warmth at low settings, grit past about 60.
            </p>
          </Stack>
        )}

        {sect === 'space' && (
          <Stack gap={4}>
            <div className="kicker">Echo (delay)</div>
            <Knob label="Amount" unit="%" min={0} max={100} step={1} value={Math.round(vals.echo * 100)}
                  onChange={(v) => set({ echo: v / 100 })} testId="echo" />
            <Knob label="Time" unit="ms" min={20} max={1500} step={10} value={Math.round(vals.echoTime * 1000)}
                  onChange={(v) => set({ echoTime: v / 1000 })} testId="echo-time" />
            <Knob label="Repeats" unit="%" min={0} max={90} step={1} value={Math.round(vals.echoFeedback * 100)}
                  onChange={(v) => set({ echoFeedback: v / 100 })} testId="echo-fb" />

            <div className="kicker" style={{ marginTop: 12 }}>Reverb (room)</div>
            <Knob label="Amount" unit="%" min={0} max={100} step={1} value={Math.round(vals.reverb * 100)}
                  onChange={(v) => set({ reverb: v / 100 })} testId="reverb" />
            <Knob label="Size" unit="s" min={0.3} max={6} step={0.1} value={vals.reverbSize}
                  onChange={(v) => set({ reverbSize: v })} testId="reverb-size" />
            <Knob label="Damping" unit="%" min={0} max={100} step={1} value={Math.round(vals.reverbDamp * 100)}
                  onChange={(v) => set({ reverbDamp: v / 100 })} testId="reverb-damp" />
            <p className="tiny" style={{ margin: '6px 0 0' }}>
              The reverb is a convolution of a synthetic room, not a recording of a real hall.
            </p>
          </Stack>
        )}

        {sect === 'fx' && (
          <Stack gap={4}>
            <div className="kicker">8D — the sound circles your head</div>
            <Knob label="8D amount" unit="%" min={0} max={100} step={1} value={Math.round(vals.rotate * 100)}
                  onChange={(v) => set({ rotate: v / 100 })} testId="rotate" />
            <Knob label="One circle every" unit="s" min={2} max={30} step={0.5} value={vals.rotateRate}
                  onChange={(v) => set({ rotateRate: v })} testId="rotate-rate" />
            <Knob label="Height" unit="" min={-100} max={100} step={5} value={Math.round(vals.rotateHeight * 100)}
                  onChange={(v) => set({ rotateHeight: v / 100 })} testId="rotate-height" />
            <p className="tiny" style={{ margin: '6px 0 0' }}>
              This is a real HRTF 3D panner being moved around you, not a stereo trick.
              On <b>headphones</b> you hear it circling. On a phone's own single speaker
              the most it can do is sweep left to right — that is a hardware limit, not a bug.
            </p>

            <div className="kicker" style={{ marginTop: 12 }}>3D width (Haas)</div>
            <Knob label="Delay one side by" unit="ms" min={0} max={40} step={1} value={Math.round(vals.haas)}
                  onChange={(v) => set({ haas: v })} testId="haas" />
            <p className="tiny" style={{ margin: '6px 0 0' }}>
              Up to about 20 ms reads as width. Past 30 ms you start hearing it as a slap.
              It also makes the track slightly weaker in mono.
            </p>

            <div className="kicker" style={{ marginTop: 12 }}>Chorus</div>
            <Knob label="Depth" unit="%" min={0} max={100} step={1} value={Math.round(vals.chorus * 100)}
                  onChange={(v) => set({ chorus: v / 100 })} testId="chorus" />
            <Knob label="Rate" unit="Hz" min={0.05} max={6} step={0.05} value={vals.chorusRate}
                  onChange={(v) => set({ chorusRate: v })} testId="chorus-rate" />

            <div className="kicker" style={{ marginTop: 12 }}>Flanger</div>
            <Knob label="Depth" unit="%" min={0} max={100} step={1} value={Math.round(vals.flanger * 100)}
                  onChange={(v) => set({ flanger: v / 100 })} testId="flanger" />
            <Knob label="Feedback" unit="%" min={0} max={90} step={1} value={Math.round(vals.flangerFeedback * 100)}
                  onChange={(v) => set({ flangerFeedback: v / 100 })} testId="flanger-fb" />

            <div className="kicker" style={{ marginTop: 12 }}>Phaser</div>
            <Knob label="Depth" unit="%" min={0} max={100} step={1} value={Math.round(vals.phaser * 100)}
                  onChange={(v) => set({ phaser: v / 100 })} testId="phaser" />
            <Knob label="Rate" unit="Hz" min={0.05} max={6} step={0.05} value={vals.phaserRate}
                  onChange={(v) => set({ phaserRate: v })} testId="phaser-rate" />

            <div className="kicker" style={{ marginTop: 12 }}>Tremolo</div>
            <Knob label="Depth" unit="%" min={0} max={100} step={1} value={Math.round(vals.tremolo * 100)}
                  onChange={(v) => set({ tremolo: v / 100 })} testId="tremolo" />
            <Knob label="Rate" unit="Hz" min={0.1} max={16} step={0.1} value={vals.tremoloRate}
                  onChange={(v) => set({ tremoloRate: v })} testId="tremolo-rate" />
          </Stack>
        )}

        {sect === 'out' && (
          <Stack gap={4}>
            <div className="kicker">Stereo</div>
            <Knob label="Width" unit="%" min={0} max={200} step={5} value={Math.round(vals.width * 100)}
                  onChange={(v) => set({ width: v / 100 })} testId="width" />
            <Knob label="Pan" unit="" min={-100} max={100} step={5} value={Math.round(vals.pan * 100)}
                  onChange={(v) => set({ pan: v / 100 })} testId="pan" />

            <div className="kicker" style={{ marginTop: 12 }}>Output</div>
            <Knob label="Level" unit="%" min={0} max={200} step={5} value={Math.round(vals.gain * 100)}
                  onChange={(v) => set({ gain: v / 100 })} testId="gain" />
            <Row style={{ marginTop: 6 }}>
              <div>
                <div className="kicker">Limiter</div>
                <div className="tiny dim">Brickwall on the way out — catches what boosting creates</div>
              </div>
              <button className={`chip ${vals.limiter ? 'active' : ''}`} data-testid="limiter"
                      onClick={() => set({ limiter: !vals.limiter })}>{vals.limiter ? 'On' : 'Off'}</button>
            </Row>
            <Knob label="Ceiling" unit="dB" min={-12} max={0} step={0.5} value={vals.ceiling}
                  onChange={(v) => set({ ceiling: v })} testId="ceiling" />
          </Stack>
        )}
      </Card>

      <Card>
        <div className="kicker">Presets</div>
        <div className="chip-row" style={{ marginTop: 10 }}>
          {Object.keys(PRESETS).map((name) => (
            <button key={name} className="chip" data-testid={`preset-${name}`}
                    onClick={() => { const p = PRESETS[name]; setVals({ ...vals, ...p }); local(p); toRoom(p); }}>
              {name}
            </button>
          ))}
          <button className="chip" onClick={() => { setVals({ ...FLAT }); local(FLAT); toRoom(FLAT); }}>Reset</button>
        </div>
      </Card>

      {chan === 'voice' && <MicTest />}

      <Card>
        <div className="kicker">What this is</div>
        <p className="tiny" style={{ margin: 0 }}>
          These are real filters running on this phone — the same kind a channel
          strip on a desk uses — and they change only what this phone plays.
          Past 100 % the level is genuine amplification, so the limiter stops it
          clipping; a small speaker still runs out of air, and no setting here
          can repair a bad recording.
        </p>
      </Card>

      <button className="chip" style={{ alignSelf: 'center' }} onClick={() => go('/')}>← Home</button>
    </Shell>
  );
}


/**
 * Live spectrum of what the strip is actually sending — drawn from the
 * channel's own analyser, so it shows the result of every control above it.
 * If the song is silent this is empty; it never animates for show.
 */
function Spectrum({ client, chan }: { client: any; chan: Chan }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const g = cv.getContext('2d');
    if (!g) return;
    let raf = 0;
    let buf: Float32Array | undefined;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const m = chan === 'music' ? client?.mixers?.music : client?.mixers?.voice;
      const w = cv.width, h = cv.height;
      g.clearRect(0, 0, w, h);
      g.fillStyle = 'rgba(255,255,255,0.04)';
      g.fillRect(0, 0, w, h);
      if (!m) return;
      buf = m.spectrum(buf as any);
      const bins = buf!.length;
      const sr = m.analyser.context.sampleRate;
      const nyq = sr / 2;
      // logarithmic frequency axis, 30 Hz … 18 kHz, like every real analyser
      const f0 = 30, f1 = 18000;
      const bars = 64;
      for (let i = 0; i < bars; i++) {
        const fa = f0 * Math.pow(f1 / f0, i / bars);
        const fb = f0 * Math.pow(f1 / f0, (i + 1) / bars);
        const ia = Math.max(0, Math.floor((fa / nyq) * bins));
        const ib = Math.min(bins - 1, Math.ceil((fb / nyq) * bins));
        let peak = -140;
        for (let k = ia; k <= ib; k++) peak = Math.max(peak, buf![k]);
        const v = Math.max(0, Math.min(1, (peak + 90) / 90));
        const bh = v * h;
        const x = (i / bars) * w;
        const bw = w / bars - 1.5;
        const hue = 190 - v * 150;
        g.fillStyle = `hsl(${hue} 90% ${35 + v * 25}%)`;
        g.fillRect(x, h - bh, bw, bh);
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [client, chan]);
  return (
    <canvas ref={ref} width={600} height={140} data-testid="spectrum"
            style={{ width: '100%', height: 110, marginTop: 12, borderRadius: 10, display: 'block' }} />
  );
}

/** Peak and RMS of the strip's output, in dBFS, with a peak hold. */
function Levels({ client, chan }: { client: any; chan: Chan }) {
  const [lv, setLv] = useState({ peak: -120, rms: -120 });
  const hold = useRef(-120);
  const [held, setHeld] = useState(-120);
  useEffect(() => {
    const t = window.setInterval(() => {
      const m = chan === 'music' ? client?.mixers?.music : client?.mixers?.voice;
      if (!m) { setLv({ peak: -120, rms: -120 }); return; }
      const l = m.levels();
      setLv(l);
      hold.current = l.peak > hold.current ? l.peak : hold.current - 1.5;
      setHeld(hold.current);
    }, 90);
    return () => window.clearInterval(t);
  }, [client, chan]);
  const pct = (db: number) => Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  return (
    <div style={{ marginTop: 10 }} data-testid="levels">
      <div style={{ position: 'relative', height: 10, borderRadius: 6, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', inset: 0, width: `${pct(lv.rms)}%`, background: 'linear-gradient(90deg,#2dd4bf,#f59e0b)' }} />
        <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${pct(held)}%`, width: 2, background: lv.peak > -1 ? '#ef4444' : '#fff' }} />
      </div>
      <div className="tiny dim" style={{ marginTop: 4 }}>
        peak {lv.peak <= -119 ? '—' : `${lv.peak.toFixed(1)} dB`} · rms {lv.rms <= -119 ? '—' : `${lv.rms.toFixed(1)} dB`}
        {lv.peak > -0.5 ? ' · clipping' : ''}
      </div>
    </div>
  );
}

/** Live input level from this phone's own microphone. */
function MicTest() {
  const [level, setLevel] = useState(0);
  const [peak, setPeak] = useState(0);
  const [on, setOn] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const stop = useRef<(() => void) | null>(null);

  useEffect(() => () => stop.current?.(), []);

  const start = async () => {
    setErr(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
      const ctx: AudioContext = new Ctor();
      await ctx.resume();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      // a silent sink keeps the graph pulling without feeding the speaker back
      const sink = ctx.createGain();
      sink.gain.value = 0;
      src.connect(an).connect(sink).connect(ctx.destination);
      const buf = new Float32Array(an.fftSize);
      let raf = 0;
      let hold = 0;
      const tick = () => {
        an.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        const rms = Math.sqrt(sum / buf.length);
        const db = 20 * Math.log10(Math.max(rms, 1e-6));
        const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
        setLevel(pct);
        hold = Math.max(hold * 0.995, pct);
        setPeak(hold);
        raf = requestAnimationFrame(tick);
      };
      tick();
      setOn(true);
      stop.current = () => {
        cancelAnimationFrame(raf);
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close();
        setOn(false);
      };
    } catch {
      setErr('This phone would not give access to its microphone.');
    }
  };

  return (
    <Card>
      <div className="kicker">Mic test</div>
      <p className="tiny" style={{ marginTop: 6 }}>
        Speak at the distance you will actually use. Aim for the bar to sit
        around two thirds — if it pins at the top you are clipping before any
        of this reaches the mixer. Nothing is sent anywhere; this is monitored
        silently so the phone cannot howl.
      </p>
      <div className="meter" style={{ marginTop: 10 }} data-testid="mic-level">
        <i className="pos" style={{ width: `${level}%` }} />
        <i className="peak" style={{ left: `${peak}%` }} />
      </div>
      <Row style={{ marginTop: 10 }}>
        <span className="mono tiny">{level.toFixed(0)}% · peak {peak.toFixed(0)}%</span>
        <Button variant="ghost" testId="mic-test" onClick={() => (on ? stop.current?.() : void start())}>
          {on ? 'STOP' : 'START MIC TEST'}
        </Button>
      </Row>
      {err && <div className="err-text" style={{ marginTop: 8 }}>{err}</div>}
    </Card>
  );
}

function Knob({ label, unit, min, max, step, value, onChange, testId }: {
  label: string; unit: string; min: number; max: number; step: number;
  value: number; onChange: (v: number) => void; testId: string;
}) {
  return (
    <div className="knob">
      <Row>
        <span>{label}</span>
        <span className="mono tiny" data-testid={`${testId}-val`}>
          {value > 0 && unit === 'dB' ? '+' : ''}{value}{unit === '%' ? '%' : ` ${unit}`}
        </span>
      </Row>
      <input
        type="range" min={min} max={max} step={step} value={value}
        data-testid={testId}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
