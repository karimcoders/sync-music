import { useEffect, useMemo, useRef, useState } from 'react';
import { SpeakerClient, type UiState } from '../lib/client';
import { P2PSpeakerClient } from '../lib/p2p/p2pSpeaker';
import { roomParam } from '../lib/mode';
import { roomIdFromCode } from '../lib/p2p/messages';
import QrScanner from '../components/QrScanner';
import { backendOrigin, setBackend } from '../lib/backend';
import { Button, Card, Equalizer, Logo, Meter, Row, Shell, Stack, Status, fmtTime } from '../ui';

type Discovered = { sessionId: string; name: string; speakerCount: number; hostOnline: boolean };

export default function Speaker({ go }: { go: (p: string) => void }) {
  const [s, setS] = useState<UiState | null>(null);
  const [sessions, setSessions] = useState<Discovered[]>([]);
  const [searching, setSearching] = useState(true);
  const [failed, setFailed] = useState(false);
  const ref = useRef<SpeakerClient | P2PSpeakerClient | null>(null);
  const room = roomParam();
  const wanted = urlParam('s');          // session id straight from the host's link
  const [code, setCode] = useState('');  // typed join code
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    // A link that carries ?h=<room> means the host has no backend and is
    // serving the session straight from its own browser (direct mode).
    const c: SpeakerClient | P2PSpeakerClient = room
      ? new P2PSpeakerClient(room, (st) => setS({ ...st }))
      : new SpeakerClient((st) => setS({ ...st }));
    ref.current = c;
    (window as any).__syncClient = c; // diagnostics / e2e only
    setS({ ...c.state });
    let stopped = false;
    const look = async () => {
      if (stopped) return;
      try {
        const found = (await c.autoConnect()) as Discovered[];
        // The link can name the session, so there is nothing to choose.
        const target = wanted && found.find((f) => f.sessionId === wanted);
        if (target) { (c as SpeakerClient).connect(target.sessionId); setSessions([]); }
        else setSessions(found);
        setFailed(false);
      } catch { setFailed(true); }
      setSearching(false);
    };
    void look();
    const iv = window.setInterval(() => { if (!ref.current?.state.sessionId) void look(); }, 4000);
    return () => { stopped = true; window.clearInterval(iv); c.disconnect(); };
  }, []);

  const c = ref.current;
  const pct = useMemo(() => (s && s.duration ? Math.min(100, (s.position / s.duration) * 100) : 0), [s]);
  if (!s) return null;

  const tone = s.conn === 'connected' ? 'ok' : s.conn === 'disconnected' ? 'idle' : 'warn';
  const label =
    s.conn === 'connected' ? (s.phase === 'SYNCING' ? 'SYNCHRONIZING' : 'CONNECTED')
    : s.conn === 'reconnecting' ? 'RECONNECTING' : s.conn === 'connecting' ? 'CONNECTING' : 'OFFLINE';

  /* -------------------------- looking for a host ------------------------ */
  if (!s.sessionId) {
    return (
      <Shell>
        <Logo sub="Speaker" />
        <Card>
          <Stack gap={14} style={{ alignItems: 'center', textAlign: 'center' }}>
            <div className="hero-emoji">{failed ? '📡' : searching ? '🔎' : sessions.length ? '🎧' : '🎧'}</div>
            <h1>
              {room ? 'Connecting to the host…'
                : failed ? 'Can’t reach the server'
                : searching ? 'Looking for a host…'
                : sessions.length ? 'Host found' : 'No host yet'}
            </h1>
            {!failed && !sessions.length && !searching && (
              <p className="dim" style={{ margin: 0 }}>
                Ask whoever is hosting to start a session. This page keeps looking by itself —
                no code to type, nothing to scan.
              </p>
            )}
            {sessions.map((x) => (
              <Card key={x.sessionId} style={{ width: '100%' }}>
                <Row>
                  <div style={{ textAlign: 'left' }}>
                    <div style={{ fontWeight: 700 }}>{x.name}</div>
                    <div className="tiny">{x.speakerCount} speakers connected</div>
                  </div>
                  <Status tone={x.hostOnline ? 'ok' : 'warn'}>{x.hostOnline ? 'live' : 'idle'}</Status>
                </Row>
                <div style={{ height: 12 }} />
                <Button testId="connect-host" onClick={() => (c as SpeakerClient)?.connect(x.sessionId)}>CONNECT</Button>
              </Card>
            ))}
            {s.error && <div className="err-text">{s.error}</div>}

            <Button testId="scan-qr" variant="ghost" onClick={() => setScanning(true)}>
              📷  SCAN THE HOST’S QR CODE
            </Button>

            <div className="divider"><span>or enter the code the host shows</span></div>
            <Row>
              <input
                className="code-input" data-testid="join-code-input" inputMode="text" autoCapitalize="characters"
                maxLength={8} placeholder="ABC123" value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
              />
              <Button testId="join-by-code" disabled={code.length < 4} onClick={() => joinByCode(code, sessions, c)}>
                JOIN
              </Button>
            </Row>
          </Stack>
        </Card>
        {scanning && (
          <QrScanner
            onClose={() => setScanning(false)}
            onResult={(text) => { setScanning(false); openScanned(text); }}
          />
        )}
        {!room && <BackendSetting promote={failed} />}
        <button className="chip" style={{ alignSelf: 'center' }} onClick={() => go('/')}>← Home</button>
      </Shell>
    );
  }

  /* ------------------------------ attached ------------------------------ */
  const enabled = c?.isAudioEnabled;
  return (
    <Shell>
      <Logo sub={s.sessionName || 'Speaker'} />

      <Card>
        <Stack gap={10} style={{ alignItems: 'center', textAlign: 'center' }}>
          <Equalizer active={s.phase === 'PLAYING'} />
          <h1>{s.speakerName || 'Speaker'}</h1>
          <Status tone={tone as any}>{label}</Status>
          {!s.hostOnline && s.conn === 'connected' && (
            <div className="warn-text">Host disconnected — waiting for the host…</div>
          )}
        </Stack>
      </Card>

      {!enabled && (
        <button className="tap-overlay" data-testid="enable-speaker" onClick={() => c?.enableSpeaker()}>
          <span className="tap-ring">🔈</span>
          <span className="tap-title">Tap anywhere to start</span>
          <span className="tap-sub">
            {s.playing
              ? 'Music is already playing — you will join it in sync.'
              : 'You will start the moment the host presses play.'}
          </span>
          <span className="tap-note">
            Android only lets a web page play sound after a tap. That is a browser security
            rule — we don’t work around it.
          </span>
        </button>
      )}

      {enabled && (
        <Card>
          <div className="center" style={{ fontWeight: 700 }}>
            {s.trackTitle ? s.trackTitle : 'Waiting for the host…'}
          </div>
          {s.trackArtist && <div className="center dim">{s.trackArtist}</div>}
          <div style={{ height: 14 }} />
          <Meter value={pct} buffered={s.bufferedPct} />
          <Row style={{ marginTop: 8 }}>
            <span className="dim mono">{fmtTime(s.position)}</span>
            <span className="dim mono">{fmtTime(s.duration)}</span>
          </Row>
          <div style={{ height: 14 }} />
          <Row>
            <Status tone={s.phase === 'PLAYING' ? 'ok' : 'warn'}>
              {s.phase === 'PLAYING' ? 'SYNCHRONIZED' : s.phase === 'SYNCING' ? 'SYNCING' : 'READY'}
            </Status>
            <span className="dim mono">
              {s.clockSynced ? `${Math.round(s.latencyMs)}ms` : '…'} · drift {s.driftMs}ms
            </span>
          </Row>
          {s.muted && <div className="warn-text center" style={{ marginTop: 10 }}>Muted by the host</div>}
          <div className="tiny" style={{ marginTop: 12 }}>
            Volume stays on your phone. Keep the screen on for the steadiest timing.
          </div>
        </Card>
      )}

      {(s.error || s.info) && (
        <Card>
          <Stack gap={10}>
            {s.error && <div className="err-text">{s.error}</div>}
            {s.info && <div className="warn-text">{s.info}</div>}
            {s.error && <Button variant="ghost" onClick={() => c?.enableSpeaker()}>Retry</Button>}
          </Stack>
        </Card>
      )}
      <div className="footer-note">Host controls everything · you only need this tab open</div>
    </Shell>
  );
}

/**
 * Only matters when the page is hosted apart from the backend (GitHub Pages,
 * surge.sh, any CDN). Same-origin deployments never see this expanded.
 */
function BackendSetting({ promote }: { promote: boolean }) {
  const current = backendOrigin || location.origin;
  const [value, setValue] = useState(current);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (promote) setOpen(true); }, [promote]);

  if (!open) {
    return (
      <div className="footer-note">
        Server: {current} ·{' '}
        <a href="#" onClick={(e) => { e.preventDefault(); setOpen(true); }}>change</a>
      </div>
    );
  }
  return (
    <Card>
      <Stack gap={10}>
        <div className="kicker">Server address</div>
        <p className="tiny" style={{ margin: 0 }}>
          This page is static, so it needs to know where the Sync Music server runs.
          Ask the host, or open a link that already contains <code>?api=…</code>.
        </p>
        <input type="url" inputMode="url" placeholder="https://api.example.com"
          value={value} onChange={(e) => setValue(e.target.value)} />
        <Button testId="save-backend" disabled={!/^https?:\/\//.test(value.trim())}
          onClick={() => setBackend(value.trim())}>SAVE &amp; CONNECT</Button>
      </Stack>
    </Card>
  );
}


function urlParam(name: string): string | null {
  const hashQuery = location.hash.includes('?') ? location.hash.slice(location.hash.indexOf('?') + 1) : '';
  return new URLSearchParams(location.search).get(name) ?? new URLSearchParams(hashQuery).get(name);
}

/**
 * Join from a typed code. In server mode the code is the first characters of
 * the session id; in direct mode it IS the room, so we just reload into it.
 */
function joinByCode(code: string, sessions: Discovered[], c: SpeakerClient | P2PSpeakerClient | null) {
  const lower = code.trim().toLowerCase();
  const match = sessions.find((x) => x.sessionId.toLowerCase().startsWith(lower));
  if (match && c instanceof SpeakerClient) { c.connect(match.sessionId); return; }
  const base = `${location.origin}${import.meta.env.BASE_URL.replace(/\/$/, '')}`;
  location.href = `${base}/#/speaker?h=${roomIdFromCode(lower)}&go=1`;
  location.reload();
}


/**
 * A scanned QR usually contains the full speaker link, but people also share
 * screenshots of just the code — accept both.
 */
function openScanned(text: string) {
  const v = text.trim();
  if (/^https?:\/\//i.test(v)) { location.href = v; location.reload(); return; }
  const clean = v.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (clean.length >= 4) {
    const base = `${location.origin}${import.meta.env.BASE_URL.replace(/\/$/, '')}`;
    location.href = `${base}/#/speaker?h=${roomIdFromCode(clean)}&go=1`;
    location.reload();
  }
}
