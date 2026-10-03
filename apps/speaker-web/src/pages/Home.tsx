import { useEffect, useState } from 'react';
import { apiUrl, backendOrigin } from '../lib/backend';
import { detectMode, type Mode } from '../lib/mode';
import { Button, Card, Logo, Row, Shell, Stack, Status } from '../ui';

export default function Home({ go }: { go: (p: string) => void }) {
  const [health, setHealth] = useState<'checking' | 'up' | 'down'>('checking');
  const [sessions, setSessions] = useState(0);
  const [mode, setMode] = useState<Mode | null>(null);
  useEffect(() => { void detectMode().then(setMode); }, []);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const r = await fetch(apiUrl('/api/session/active'), { cache: 'no-store' });
        const d = await r.json();
        if (!alive) return;
        setSessions(d.sessions?.length ?? 0);
        setHealth('up');
      } catch { if (alive) setHealth('down'); }
    };
    void check();
    const iv = window.setInterval(check, 5000);
    return () => { alive = false; window.clearInterval(iv); };
  }, []);

  return (
    <Shell>
      <Logo sub="Play one song on many phones" />

      <Card>
        <Stack gap={14}>
          <h1>Turn the phones around you into one speaker system</h1>
          <p className="dim" style={{ margin: 0 }}>
            One phone hosts. Everyone else opens a link in their browser and taps once.
            Playback is scheduled on a shared server clock, so the phones start together
            and stay together.
          </p>
          <Row>
            <Status tone={mode === 'direct' ? 'ok' : health === 'up' ? 'ok' : health === 'down' ? 'err' : 'warn'}>
              {mode === 'direct' ? 'Direct mode — no server needed'
                : health === 'up' ? 'Server online'
                : health === 'down' ? 'Server unreachable' : 'Checking…'}
            </Status>
            {mode !== 'direct' && (
              <span className="dim mono">{sessions} active session{sessions === 1 ? '' : 's'}</span>
            )}
          </Row>
          {mode === 'direct' && (
            <p className="tiny" style={{ margin: 0 }}>
              No backend is configured, so the host's browser runs the session itself and the
              phones connect to it directly (WebRTC). Nothing to install or deploy — just keep
              the host tab open.
            </p>
          )}
        </Stack>
      </Card>

      <Card>
        <Stack gap={12}>
          <div className="kicker">I want to…</div>
          <Button testId="go-host" onClick={() => go('/host')}>🎛  CONTROL THE MUSIC (HOST)</Button>
          <Button testId="go-speaker" variant="ghost" onClick={() => go('/speaker')}>🔊  BE A SPEAKER</Button>
          <Button testId="go-sound" variant="ghost" onClick={() => go('/sound')}>🎚  SOUND CHECK (MIC TOOLS)</Button>
        </Stack>
      </Card>

      <Card>
        <div className="kicker">How it works</div>
        <div className="list">
          {[
            ['1', 'Host starts a session', 'A link is created. No QR, no PIN, nothing to type.'],
            ['2', 'Phones open the speaker link', 'They find the host by themselves and tap Enable Speaker once.'],
            ['3', 'Host presses play', 'Every phone is told to start at the same server timestamp.'],
            ['4', 'Drift is corrected continuously', 'Tiny playback-rate nudges, not jarring jumps.'],
          ].map(([n, t, d]) => (
            <div className="list-item" key={n}>
              <span className="chip" style={{ minWidth: 30, textAlign: 'center' }}>{n}</span>
              <div className="grow">
                <div>{t}</div>
                <div className="tiny">{d}</div>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <div className="footer-note">
        Add as many speaker phones as your network and server can support — there is no
        built-in device limit. Sync is measured in tens of milliseconds, never claimed to be perfect.
        {backendOrigin && <><br />Server: {backendOrigin}</>}
      </div>
    </Shell>
  );
}
