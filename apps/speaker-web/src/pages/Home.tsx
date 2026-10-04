import { useEffect, useState } from 'react';
import { detectMode, type Mode } from '../lib/mode';
import { isUnlocked } from '../lib/auth';
import { AppBar, Button, Card, Icons, Shell, Stack } from '../ui';

/**
 * Home.
 *
 * Deliberately almost empty: a guest who was handed the link should see one
 * obvious thing to do — become a speaker. The controller lives behind the
 * small lock in the corner, and is not advertised at all.
 */
export default function Home({ go }: { go: (p: string) => void }) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [unlocked, setUnlocked] = useState(isUnlocked());
  useEffect(() => { void detectMode().then(setMode); }, []);
  useEffect(() => {
    const t = window.setInterval(() => setUnlocked(isUnlocked()), 1000);
    return () => window.clearInterval(t);
  }, []);

  return (
    <Shell>
      <AppBar
        title="Sync Music"
        sub="One song, every phone"
        right={(
          <button
            className="lock-btn" data-testid="host-lock" aria-label="Host sign in"
            onClick={() => go('/host')}
          >{Icons.lock}</button>
        )}
      />

      <Card className="hero">
        <div className="hero-art" aria-hidden>
          <span /><span /><span /><span /><span />
        </div>
        <h1 className="hero-title">Make every phone one speaker</h1>
        <p className="hero-sub">
          Tap once and this phone joins the music. No app, no code, nothing to set up.
        </p>
        <Button testId="go-speaker" onClick={() => go('/speaker')}>JOIN AS A SPEAKER</Button>
        <Button testId="go-sound" variant="ghost" onClick={() => go('/sound')}>
          Sound check tools
        </Button>
      </Card>

      {unlocked && (
        <Card>
          <Stack gap={10}>
            <div className="kicker">Owner</div>
            <Button testId="go-host" variant="ghost" onClick={() => go('/host')}>
              OPEN THE PLAYER
            </Button>
          </Stack>
        </Card>
      )}

      <Card>
        <div className="kicker">What to expect</div>
        <ul className="tips">
          <li>Your phone needs this page open and one tap — Android only allows sound after that.</li>
          <li>Phones start within a few tens of milliseconds of each other, not perfectly together.</li>
          <li>Once a song has reached your phone it keeps playing even if your network drops.</li>
          {mode === 'direct' && <li>No server involved: phones talk straight to the host over WebRTC.</li>}
        </ul>
      </Card>

      <div className="footer-note">build {__BUILD__}</div>
    </Shell>
  );
}
