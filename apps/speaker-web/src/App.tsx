import { useEffect, useMemo, useRef, useState } from 'react';
import { SpeakerClient, type UiState } from './lib/client';
import { backendOrigin, setBackend } from './lib/backend';

type Discovered = { sessionId: string; name: string; speakerCount: number; hostOnline: boolean };

const fmt = (s: number) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
};

export default function App() {
  const [state, setState] = useState<UiState | null>(null);
  const [sessions, setSessions] = useState<Discovered[]>([]);
  const [searching, setSearching] = useState(true);
  const clientRef = useRef<SpeakerClient | null>(null);

  useEffect(() => {
    const c = new SpeakerClient((s) => setState({ ...s }));
    clientRef.current = c;
    setState({ ...c.state });

    let stopped = false;
    const look = async () => {
      if (stopped) return;
      const found = await c.autoConnect();
      setSessions(found as Discovered[]);
      setSearching(false);
    };
    void look();
    // keep polling for a host while we are not attached to one
    const iv = window.setInterval(() => {
      if (!clientRef.current?.state.sessionId) void look();
    }, 4000);
    return () => { stopped = true; window.clearInterval(iv); c.disconnect(); };
  }, []);

  const s = state;
  const pct = useMemo(() => (s && s.duration ? Math.min(100, (s.position / s.duration) * 100) : 0), [s]);
  if (!s) return null;

  const connDot =
    s.conn === 'connected' ? 'ok' : s.conn === 'reconnecting' || s.conn === 'connecting' ? 'warn' : 'err';
  const connLabel =
    s.conn === 'connected' ? (s.phase === 'SYNCING' ? 'Synchronizing' : 'Connected')
    : s.conn === 'reconnecting' ? 'Reconnecting' : s.conn === 'connecting' ? 'Connecting' : 'Disconnected';

  /* ---------------------- not attached to a host ---------------------- */
  if (!s.sessionId) {
    return (
      <div className="wrap">
        <div className="brand">Sync Music</div>
        <div className="card center stack">
          {searching && <><div className="big">🔎</div><h1>Looking for active Host…</h1></>}
          {!searching && sessions.length === 0 && (
            <>
              <div className="big">🎧</div>
              <h1>No active Host yet</h1>
              <p className="dim">Ask the host to start a session. This page keeps looking automatically — no code, no QR.</p>
            </>
          )}
          {!searching && sessions.length > 0 && (
            <>
              <div className="dim">Available Host</div>
              {sessions.map((x) => (
                <div key={x.sessionId} className="stack" style={{ width: '100%' }}>
                  <div className="row">
                    <div>
                      <div style={{ fontWeight: 700 }}>● {x.name}</div>
                      <div className="dim">{x.speakerCount} speakers connected</div>
                    </div>
                  </div>
                  <button onClick={() => clientRef.current?.connect(x.sessionId)}>CONNECT</button>
                </div>
              ))}
            </>
          )}
          {s.error && <div className="err">{s.error}</div>}
        </div>
        <BackendSetting />
      </div>
    );
  }

  /* -------------------------- attached states ------------------------- */
  return (
    <div className="wrap">
      <div className="brand">Sync Music</div>

      <div className="card center stack">
        <div className="wave">{s.phase === 'PLAYING' ? '🔊' : '🔈'}</div>
        <h1>{s.speakerName || 'Speaker'}</h1>
        <div className="pill" style={{ justifyContent: 'center' }}>
          <span className={`dot ${connDot}`} /> {connLabel}
          {!s.hostOnline && s.conn === 'connected' && <span className="info"> · Host disconnected</span>}
        </div>
        <div className="dim">{s.sessionName}</div>
      </div>

      {!clientRef.current?.isAudioEnabled && (
        <div className="card stack center">
          <div className="dim">
            Android requires one tap before a web page may play sound. This is a browser security rule and
            cannot (and should not) be bypassed.
          </div>
          <button onClick={() => clientRef.current?.enableSpeaker()}>ENABLE SPEAKER</button>
        </div>
      )}

      {clientRef.current?.isAudioEnabled && (
        <div className="card stack">
          <div className="center" style={{ fontWeight: 700 }}>
            {s.trackTitle ? `🎵 ${s.trackTitle}` : 'Waiting for Host…'}
          </div>
          {s.trackArtist && <div className="center dim">{s.trackArtist}</div>}

          <div className="bar"><i className="buf" style={{ width: `${s.bufferedPct}%`, marginTop: -0 }} /></div>
          <div className="bar"><i style={{ width: `${pct}%` }} /></div>
          <div className="row mono dim">
            <span>{fmt(s.position)}</span><span>{fmt(s.duration)}</span>
          </div>

          <div className="row">
            <span className="pill">
              <span className={`dot ${s.phase === 'PLAYING' ? 'ok' : 'warn'}`} />
              {s.phase === 'PLAYING' ? 'SYNCHRONIZED' : s.phase === 'SYNCING' ? 'SYNCHRONIZING' : 'SPEAKER ACTIVE'}
            </span>
            <span className="dim mono">
              Latency: {s.clockSynced ? `${Math.round(s.latencyMs)}ms` : '…'} · Drift: {s.driftMs}ms
            </span>
          </div>
          {s.muted && <div className="info center">Muted by host</div>}
          <div className="dim center" style={{ fontSize: 12 }}>
            Device volume stays under your phone's control. Keep the screen on for best results.
          </div>
        </div>
      )}

      {(s.error || s.info) && (
        <div className="card stack">
          {s.error && <div className="err">{s.error}</div>}
          {s.info && <div className="info">{s.info}</div>}
          {s.error && (
            <button className="secondary" onClick={() => clientRef.current?.enableSpeaker()}>Retry</button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * When this page is served from a static host (surge.sh, Pages, S3…) it has no
 * backend of its own, so the server origin is configurable — once, here or via
 * ?api=https://… in the link the host shares.
 */
function BackendSetting() {
  const current = backendOrigin || location.origin;
  const [value, setValue] = useState(current);
  const [open, setOpen] = useState(!backendOrigin && !import.meta.env.VITE_BACKEND_URL);
  if (!open) {
    return (
      <div className="center dim" style={{ fontSize: 12 }}>
        Server: {current} · <a href="#" style={{ color: 'var(--ok)' }} onClick={(e) => { e.preventDefault(); setOpen(true); }}>change</a>
      </div>
    );
  }
  return (
    <div className="card stack">
      <div className="dim" style={{ fontSize: 13 }}>
        Server address (the machine running the Sync Music backend):
      </div>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="https://api.yourdomain.com"
        inputMode="url"
        style={{
          width: '100%', padding: 12, borderRadius: 12, border: '1px solid var(--line)',
          background: '#0f1322', color: 'var(--fg)', fontSize: 15,
        }}
      />
      <button onClick={() => setBackend(value.trim())} disabled={!/^https?:\/\//.test(value.trim())}>
        SAVE &amp; CONNECT
      </button>
      <div className="dim" style={{ fontSize: 11 }}>
        A static page cannot host the server. Ask the host for this address, or open a link
        that already contains <code>?api=…</code>.
      </div>
    </div>
  );
}
