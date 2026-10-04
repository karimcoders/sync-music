import { useState } from 'react';
import { AppBar, Button, Card, Field, Icons, Shell, Stack } from '../ui';
import { DEFAULT_ID, check, isConfigured, setCredentials, unlock } from '../lib/auth';

/**
 * Sign-in for the controller.
 *
 * On a phone that has never been set up, the shipped default (admin /
 * syncmusic) gets the owner in once and they are asked to choose their own
 * id and password straight away.
 */
export default function HostLogin({ go, onUnlock }: { go: (p: string) => void; onUnlock: () => void }) {
  const configured = isConfigured();
  const [id, setId] = useState(configured ? '' : DEFAULT_ID);
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState(false);
  const [newPw, setNewPw] = useState('');
  const [newPw2, setNewPw2] = useState('');

  const submit = async () => {
    setBusy(true);
    setErr(null);
    const ok = await check(id, pw);
    setBusy(false);
    if (!ok) { setErr('Wrong id or password.'); return; }
    if (!configured) { setSetup(true); return; }   // first run: pick your own
    unlock();
    onUnlock();
  };

  const save = async () => {
    if (newPw.length < 4) { setErr('Use at least 4 characters.'); return; }
    if (newPw !== newPw2) { setErr('The two passwords do not match.'); return; }
    await setCredentials(id || DEFAULT_ID, newPw);
    onUnlock();
  };

  return (
    <Shell>
      <AppBar title={setup ? 'Choose a password' : 'Owner sign in'} sub="Controller" />
      <Card>
        <Stack gap={14}>
          <div className="lock-screen">
            <div className="lock-badge">{Icons.lock}</div>
            <p className="dim" style={{ margin: 0 }}>
              {setup
                ? 'Pick the id and password you will use on this phone from now on.'
                : 'Only the person running the music signs in here. Everyone else just taps “Join as a speaker”.'}
            </p>
          </div>

          {!setup ? (
            <>
              <Field label="Id">
                <input
                  type="text" data-testid="host-id" autoComplete="username" autoCapitalize="none"
                  value={id} onChange={(e) => setId(e.target.value)}
                />
              </Field>
              <Field label="Password">
                <input
                  type="password" data-testid="host-pw" autoComplete="current-password"
                  value={pw} onChange={(e) => setPw(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
                />
              </Field>
              <Button testId="host-signin" disabled={busy || !pw} onClick={() => void submit()}>
                {busy ? 'CHECKING…' : 'SIGN IN'}
              </Button>
              {!configured && (
                <p className="tiny" style={{ margin: 0 }}>
                  First time on this phone? Sign in with <b>admin</b> / <b>syncmusic</b> and you
                  will be asked to choose your own password immediately.
                </p>
              )}
            </>
          ) : (
            <>
              <Field label="Id">
                <input type="text" value={id} onChange={(e) => setId(e.target.value)} />
              </Field>
              <Field label="New password">
                <input type="password" data-testid="new-pw" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
              </Field>
              <Field label="Repeat it">
                <input type="password" data-testid="new-pw2" value={newPw2} onChange={(e) => setNewPw2(e.target.value)} />
              </Field>
              <Button testId="save-pw" onClick={() => void save()}>SAVE AND OPEN THE PLAYER</Button>
            </>
          )}

          {err && <div className="err-text" data-testid="login-error">{err}</div>}
        </Stack>
      </Card>

      <Card>
        <div className="kicker">Honest note</div>
        <p className="tiny" style={{ margin: 0 }}>
          This page is static, so the lock hides the controller — it is not server-enforced
          security, and the password is kept only as a salted hash on this phone. It stops a
          guest from grabbing the music; it is not protection against someone determined.
          The backend in <code>server/</code> checks a real token on every command.
        </p>
      </Card>

      <button className="chip" style={{ alignSelf: 'center' }} onClick={() => go('/')}>← Back</button>
    </Shell>
  );
}
