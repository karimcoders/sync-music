import { useEffect, useMemo, useRef, useState } from 'react';
import { SpeakerClient, type UiState } from '../lib/client';
import { P2PSpeakerClient } from '../lib/p2p/p2pSpeaker';
import { detectMode, roomParam, type Mode } from '../lib/mode';
import { FIXED_ROOM_ID, roomIdFromCode } from '../lib/p2p/messages';
import QrScanner from '../components/QrScanner';
import { backendOrigin, setBackend } from '../lib/backend';
import { acquireSpeaker, leaveSpeaker } from '../lib/p2p/speakerSingleton';
import { AppBar, Button, Card, Equalizer, Logo, Meter, Row, Shell, Stack, Status, fmtTime, Icons , useMood } from '../ui';

type Discovered = { sessionId: string; name: string; speakerCount: number; hostOnline: boolean };

export default function Speaker({ go }: { go: (p: string) => void }) {
  const [s, setS] = useState<UiState | null>(null);
  // the screen's colour says what is happening, readable from across a room
  useMood(
    !s || s.conn === 'disconnected' ? 'idle'
      : s.error || s.conn === 'reconnecting' ? 'trouble'
      : s.playing ? 'playing' : 'connected',
  );
  const [sessions, setSessions] = useState<Discovered[]>([]);
  const [searching, setSearching] = useState(true);
  const [failed, setFailed] = useState(false);
  const ref = useRef<SpeakerClient | P2PSpeakerClient | null>(null);
  const linkRoom = roomParam();
  const wanted = urlParam('s');          // session id straight from the host's link
  const [code, setCode] = useState('');  // typed join code
  const [scanning, setScanning] = useState(false);
  const [mode, setMode] = useState<Mode | null>(linkRoom ? 'direct' : null);
  // There is only ONE room. Without a backend this page joins it straight
  // away, so the same link (or QR) works for everybody, every time — nothing
  // to type, no new URL per session.
  const room = linkRoom ?? (mode === 'direct' ? FIXED_ROOM_ID : null);

  // Without a backend there is nothing to "discover": the phone has to be
  // pointed at a host, by QR, link or code. Decide that before connecting,
  // otherwise a static deployment wrongly reports "can't reach the server".
  useEffect(() => { if (!linkRoom) void detectMode().then(setMode); }, [linkRoom]);

  useEffect(() => {
    if (!room && mode !== 'server') return;   // direct mode: wait for a QR/code
    // The client lives in speakerSingleton, NOT in this page. This page used
    // to create it on mount and disconnect it on unmount, so tapping the
    // MIXER tab dropped the phone out of the room and tore its audio down —
    // the mixer then had nothing to control. Now the page only watches it.
    const { client: c, release } = acquireSpeaker(room, (st) => setS({ ...st }));
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
    return () => { stopped = true; window.clearInterval(iv); release(); };
  }, [room, mode]);

  // An out-of-date phone is the cause of a whole family of "it is behaving
  // strangely" reports: it speaks a slightly different protocol to the host,
  // and the person holding it has no reason to suspect a cached build. So
  // update it instead of asking. Once per load, and only ever forwards.
  const updating = useRef(false);
  useEffect(() => {
    const hb = s?.hostBuild;
    if (!hb || hb <= __BUILD__ || updating.current) return;
    updating.current = true;
    const t = window.setTimeout(() => { void refreshApp(); }, 1500);
    return () => window.clearTimeout(t);
  }, [s?.hostBuild]);

  const c = ref.current;
  // NB: all hooks must run before any early return below.
  const pct = useMemo(() => (s && s.duration ? Math.min(100, (s.position / s.duration) * 100) : 0), [s]);

  if (!room && mode === 'direct') {
    return (
      <Shell tab="speaker" go={go}>
        <AppBar title="Speaker" sub="This phone" />

      {s?.youtubeId && (
        <div className="tiny dim" style={{ textAlign: 'center' }}>
          Playing from YouTube on this phone — it needs internet, and alignment
          is coarser than with a song file.
        </div>
      )}
        <Card>
          <Stack gap={14} style={{ alignItems: 'center', textAlign: 'center' }}>
            <div className="hero-emoji">📷</div>
            <h1>Point this phone at the host</h1>
            <p className="dim" style={{ margin: 0 }}>
              This page is running without a server, so it cannot look for hosts by itself.
              Scan the QR code on the host’s screen, or type the code it shows.
            </p>
            <Button testId="scan-qr" onClick={() => setScanning(true)}>📷  SCAN QR CODE</Button>
            <div className="divider"><span>or enter the code</span></div>
            <Row>
              <input
                className="code-input" data-testid="join-code-input" inputMode="text"
                autoCapitalize="characters" maxLength={8} placeholder="ABC123" value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
              />
              <Button testId="join-by-code" disabled={code.length < 4} onClick={() => joinByCode(code, [], null)}>
                JOIN
              </Button>
            </Row>
          </Stack>
        </Card>
        {scanning && (
          <QrScanner onClose={() => setScanning(false)}
            onResult={(text) => { setScanning(false); openScanned(text); }} />
        )}
        <div className="footer-note">
          Tip: the host page is on this same site — open it on whichever phone has the music.
        </div>
        <button className="chip" style={{ alignSelf: 'center' }} onClick={() => go('/')}>← Home</button>
      </Shell>
    );
  }

  if (!s) return null;

  // What the chip must answer is "is my phone doing its job right now?", not
  // "is the control channel momentarily quiet?". A phone that is playing the
  // right song in sync is working, even while it re-opens its link in the
  // background, and shouting RECONNECTING over that is just alarming.
  const sounding = s.phase === 'PLAYING' || (s.playing === true && s.conn !== 'disconnected');
  const tone = s.conn === 'connected' || sounding ? 'ok' : s.conn === 'disconnected' ? 'idle' : 'warn';
  const label =
    s.conn === 'connected' ? (s.phase === 'SYNCING' ? 'SYNCHRONIZING' : 'CONNECTED')
    : sounding ? 'PLAYING'
    : s.conn === 'reconnecting' ? 'RECONNECTING' : s.conn === 'connecting' ? 'CONNECTING' : 'OFFLINE';

  /* -------------------------- looking for a host ------------------------ */
  if (!s.sessionId) {
    return (
      <Shell tab="speaker" go={go}>
        <AppBar title="Speaker" sub="This phone" />

      {s?.youtubeId && (
        <div className="tiny dim" style={{ textAlign: 'center' }}>
          Playing from YouTube on this phone — it needs internet, and alignment
          is coarser than with a song file.
        </div>
      )}
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
            <Diag lines={s.diag} />

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
    <Shell tab="speaker" go={go}>
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
          <span className="tap-ring">{Icons.speaker}</span>
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
          {s.hostMic && (
            <div className="mic-live" data-testid="host-mic">
              <span className="dot" />
              <div>
                <div style={{ fontWeight: 700 }}>Host is speaking</div>
                <div className="tiny">Live microphone — it plays on top of the music.</div>
              </div>
            </div>
          )}
          {s.muted && <div className="warn-text center" style={{ marginTop: 10 }}>Muted by the host</div>}
          {c instanceof P2PSpeakerClient && (
            <>
              <div style={{ height: 14 }} />
              <div className="kicker">Fine-tune this phone</div>
              <p className="tiny" style={{ margin: '4px 0 8px' }}>
                Every phone has its own audio output delay, so two phones can still echo even
                when their clocks agree. If this one sounds <b>late</b>, drag right; if it sounds
                <b> early</b>, drag left. It is remembered on this phone.
              </p>
              <Row>
                <button className="chip" data-testid="nudge-minus"
                  onClick={() => { c.setOutputOffsetMs(c.outputOffsetMs - 20); setS({ ...c.state }); }}>
                  −20 ms
                </button>
                <span className="mono" data-testid="nudge-value">{c.outputOffsetMs > 0 ? '+' : ''}{c.outputOffsetMs} ms</span>
                <button className="chip" data-testid="nudge-plus"
                  onClick={() => { c.setOutputOffsetMs(c.outputOffsetMs + 20); setS({ ...c.state }); }}>
                  +20 ms
                </button>
              </Row>
              <input
                type="range" min={-300} max={300} step={10} value={c.outputOffsetMs}
                onChange={(e) => { c.setOutputOffsetMs(+e.target.value); setS({ ...c.state }); }}
              />
              {c.outputOffsetMs !== 0 && (
                <button className="chip" onClick={() => { c.setOutputOffsetMs(0); setS({ ...c.state }); }}>
                  Reset to 0
                </button>
              )}
            </>
          )}
          <div className="tiny" style={{ marginTop: 12 }}>
            Volume stays on your phone. Keep the screen on for the steadiest timing.
          </div>
        </Card>
      )}

      {s.hostBuild && (
        <Card>
          <Stack gap={8}>
            <div className="warn-text" data-testid="version-mismatch">
              {s.hostBuild > __BUILD__
                ? `This phone is on an older version (${__BUILD__}) than the host (${s.hostBuild}) — updating it now.`
                : `The host runs an OLDER version (${s.hostBuild}) than this phone (${__BUILD__}). Reload the host page.`}
            </div>
            {s.hostBuild > __BUILD__
              && <Button variant="ghost" onClick={() => void refreshApp()}>UPDATE NOW</Button>}
          </Stack>
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
      {s.conn !== 'connected' && <Card><Diag lines={s.diag} /></Card>}
      <Row style={{ justifyContent: 'center', gap: 10 }}>
        <button className="chip" data-testid="leave-room" onClick={() => { leaveSpeaker(); go('/'); }}>Leave this room</button>
      </Row>
      <div className="footer-note">
        Host controls everything · you only need this tab open · build {__BUILD__}
      </div>
    </Shell>
  );
}

/** Plain-language connection progress: what is being tried, and where it is stuck. */
function Diag({ lines }: { lines?: string[] }) {
  if (!lines?.length) return null;
  return (
    <div className="tiny mono" data-testid="conn-diag" style={{ textAlign: 'left', opacity: 0.8, lineHeight: 1.6 }}>
      {lines.map((l) => <div key={l}>{l}</div>)}
    </div>
  );
}

/** Drop the cached app shell (never the downloaded songs) and load the newest build. */
async function refreshApp() {
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
    await Promise.all(regs.map((r) => r.unregister()));
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('sync-music-shell')).map((k) => caches.delete(k)));
  } catch { /* reload anyway */ }
  location.reload();
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
