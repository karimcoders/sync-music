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
  const [vals, setVals] = useState<MixerSettings>(() => client?.mixOf('music') ?? { ...FLAT });
  const [reduction, setReduction] = useState(0);

  useMood('connected');

  // follow the running speaker (it keeps running while this page is open)
  useEffect(() => client?.subscribe(() => repaint((n) => n + 1)), [client]);

  useEffect(() => { setVals(client?.mixOf(chan) ?? { ...FLAT }); }, [chan, client]);

  // how hard the limiter is working — honest feedback that you are pushing it
  useEffect(() => {
    const t = window.setInterval(() => {
      const m = chan === 'music' ? client?.mixers.music : client?.mixers.voice;
      setReduction(m ? Math.round(m.reduction) : 0);
    }, 300);
    return () => window.clearInterval(t);
  }, [chan, client]);

  const set = (patch: Partial<MixerSettings>) => {
    const next = { ...vals, ...patch };
    setVals(next);
    client?.setMix(chan, patch);
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

        <Stack gap={4} style={{ marginTop: 14 }}>
          <Knob label="Bass" unit="dB" min={-12} max={12} step={0.5} value={vals.bass}
                onChange={(v) => set({ bass: v })} testId="bass" />
          <Knob label="Mid" unit="dB" min={-12} max={12} step={0.5} value={vals.mid}
                onChange={(v) => set({ mid: v })} testId="mid" />
          <Knob label="Treble" unit="dB" min={-12} max={12} step={0.5} value={vals.treble}
                onChange={(v) => set({ treble: v })} testId="treble" />
          <Knob label="Level" unit="%" min={0} max={200} step={5} value={Math.round(vals.gain * 100)}
                onChange={(v) => set({ gain: v / 100 })} testId="gain" />
        </Stack>
      </Card>

      <Card>
        <div className="kicker">Echo</div>
        <Stack gap={4} style={{ marginTop: 10 }}>
          <Knob label="Amount" unit="%" min={0} max={100} step={1} value={Math.round(vals.echo * 100)}
                onChange={(v) => set({ echo: v / 100 })} testId="echo" />
          <Knob label="Time" unit="ms" min={50} max={1000} step={10} value={Math.round(vals.echoTime * 1000)}
                onChange={(v) => set({ echoTime: v / 1000 })} testId="echo-time" />
          <Knob label="Repeats" unit="%" min={0} max={90} step={1} value={Math.round(vals.echoFeedback * 100)}
                onChange={(v) => set({ echoFeedback: v / 100 })} testId="echo-fb" />
        </Stack>
      </Card>

      <Card>
        <Row>
          <div>
            <div className="kicker">Limiter</div>
            <div className="tiny dim">Catches the peaks that boosting creates</div>
          </div>
          <button className={`chip ${vals.limiter ? 'active' : ''}`} data-testid="limiter"
                  onClick={() => set({ limiter: !vals.limiter })}>
            {vals.limiter ? 'On' : 'Off'}
          </button>
        </Row>
        <div className="tiny" style={{ marginTop: 8 }} data-testid="reduction">
          {reduction > 0.5
            ? `Holding back ${reduction} dB right now — the channel is past what the speaker can take cleanly.`
            : 'Not working — the level is within what the speaker can take.'}
        </div>
      </Card>

      <Card>
        <div className="kicker">Presets</div>
        <div className="chip-row" style={{ marginTop: 10 }}>
          {Object.keys(PRESETS).map((name) => (
            <button key={name} className="chip" data-testid={`preset-${name}`}
                    onClick={() => { const p = PRESETS[name]; setVals({ ...vals, ...p }); client?.setMix(chan, p); toRoom(p); }}>
              {name}
            </button>
          ))}
          <button className="chip" onClick={() => { setVals({ ...FLAT }); client?.setMix(chan, FLAT); toRoom(FLAT); }}>Reset</button>
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
