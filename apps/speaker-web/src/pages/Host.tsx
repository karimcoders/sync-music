import { useEffect, useMemo, useRef, useState } from 'react';
import { HostClient, type HostState } from '../lib/hostClient';
import { backendOrigin } from '../lib/backend';
import { Button, Card, Equalizer, Field, Logo, Meter, Row, Shell, Stack, Status, fmtTime } from '../ui';

const speakerLink = () => `${location.origin}${import.meta.env.BASE_URL}speaker`;

export default function Host({ go }: { go: (p: string) => void }) {
  const [s, setS] = useState<HostState | null>(null);
  const ref = useRef<HostClient | null>(null);
  const [name, setName] = useState('My Music');
  const [seekPreview, setSeekPreview] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const c = new HostClient((st) => setS({ ...st }));
    ref.current = c;
    setS({ ...c.state });
    const saved = c.saved;
    if (saved) c.attach(saved.sessionId, saved.token); // survives a refresh
    return () => c.dispose();
  }, []);

  const c = ref.current;
  const track = c?.track ?? null;
  const dur = track?.duration ?? 0;
  const pos = seekPreview ?? s?.position ?? 0;
  const pct = useMemo(() => (dur ? Math.min(100, (pos / dur) * 100) : 0), [pos, dur]);
  if (!s) return null;

  const tone = s.conn === 'connected' ? 'ok' : s.conn === 'offline' ? 'idle' : 'warn';
  const label = s.conn === 'connected' ? 'LIVE' : s.conn.toUpperCase();

  /* ----------------------------- no session ---------------------------- */
  if (!s.sessionId) {
    return (
      <Shell>
        <Logo sub="Host" />
        <Card>
          <Stack gap={14}>
            <h1>Start a session</h1>
            <p className="dim" style={{ margin: 0 }}>
              Your phone becomes the controller. Every other phone just opens a link in its
              browser — no app, no QR code, no room code.
            </p>
            <Field label="Session name (speakers see this)">
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Button testId="create-session" disabled={s.busy} onClick={() => c?.createSession(name || 'My Music')}>
              {s.busy ? 'CREATING…' : 'CREATE SESSION'}
            </Button>
            {s.error && <div className="err-text">{s.error}</div>}
            {s.info && <div className="warn-text">{s.info}</div>}
          </Stack>
        </Card>
        <Card>
          <div className="kicker">Heads up</div>
          <p className="tiny" style={{ marginBottom: 0 }}>
            This browser console speaks the same protocol as the Android host app
            (<code>apps/host-android</code>) — same REST, same WebSocket, same server-timestamp
            scheduling. Use whichever you have at hand.
          </p>
        </Card>
        <button className="chip" style={{ alignSelf: 'center' }} onClick={() => go('/')}>← Back</button>
      </Shell>
    );
  }

  /* ------------------------------- live -------------------------------- */
  return (
    <Shell>
      <Logo sub={s.sessionName || 'Host'} />

      <Card>
        <Row>
          <Status tone={tone as any}>{label}</Status>
          <span className="dim mono">avg drift {s.avgDriftMs}ms · lat {s.avgLatencyMs}ms</span>
        </Row>
        <div style={{ height: 14 }} />
        <Row>
          <div>
            <div className="kicker">Connected speakers</div>
            <div className="big-number" data-testid="speaker-count">{s.speakerCount}</div>
          </div>
          <Equalizer active={!!c?.playing} />
        </Row>
        <div className="tiny">No maximum — add as many phones as your network and server can carry.</div>
        <div style={{ height: 14 }} />
        <div className="kicker">Speaker link — share it any way you like</div>
        <Row style={{ marginTop: 6 }}>
          <a href={speakerLink()} target="_blank" rel="noreferrer">{speakerLink()}</a>
          <button
            className="icon-btn"
            onClick={() => { navigator.clipboard?.writeText(speakerLink()); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
          >{copied ? 'Copied' : 'Copy'}</button>
        </Row>
        {backendOrigin && <div className="tiny" style={{ marginTop: 6 }}>Server: {backendOrigin}</div>}
      </Card>

      <Card>
        <div className="kicker">Now playing</div>
        <h2 style={{ marginTop: 6 }}>{track ? track.title : 'No song selected'}</h2>
        <div className="dim">{track ? track.artist : 'Add a song below to get started'}</div>
        <div style={{ height: 14 }} />
        <Meter value={pct} />
        <input
          type="range" min={0} max={1000} value={dur ? Math.round((pos / dur) * 1000) : 0}
          onChange={(e) => setSeekPreview((+e.target.value / 1000) * dur)}
          onMouseUp={() => { if (seekPreview != null) c?.seek(seekPreview); setSeekPreview(null); }}
          onTouchEnd={() => { if (seekPreview != null) c?.seek(seekPreview); setSeekPreview(null); }}
          disabled={!track}
        />
        <Row>
          <span className="dim mono">{fmtTime(pos)}</span>
          <span className="dim mono">{fmtTime(dur)}</span>
        </Row>
        <div style={{ height: 12 }} />
        <div className="btn-grid three">
          <Button variant="ghost" onClick={() => c?.prev()}>‹ Prev</Button>
          <Button testId="play" onClick={() => c?.toggle()} disabled={(s.transport?.playlist.length ?? 0) === 0}>
            {c?.playing ? '❚❚  PAUSE' : '▶  PLAY'}
          </Button>
          <Button variant="ghost" onClick={() => c?.next()}>Next ›</Button>
        </div>
        <div style={{ height: 10 }} />
        <div className="btn-grid">
          <Button variant="ghost" onClick={() => c?.stop()}>Stop</Button>
          <Button variant="ghost" onClick={() => c?.resync()}>Resync all</Button>
        </div>
        <div style={{ height: 14 }} />
        <div className="kicker">Master volume</div>
        <input
          type="range" min={0} max={100}
          defaultValue={Math.round((s.transport?.volume ?? 1) * 100)}
          onChange={(e) => c?.volume(+e.target.value / 100)}
        />
        <div className="tiny">
          This is the software volume inside each speaker's browser. Every phone's hardware
          volume stays under the control of its own Android OS.
        </div>
      </Card>

      <Card>
        <Row>
          <div className="kicker">Playlist</div>
          <label className="chip" style={{ cursor: 'pointer' }}>
            + Add song
            <input
              type="file" data-testid="file" hidden
              accept="audio/mpeg,audio/mp4,audio/aac,audio/x-m4a,audio/wav"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void c?.upload(f); e.currentTarget.value = ''; }}
            />
          </label>
        </Row>
        {s.uploading && <><div style={{ height: 10 }} /><Meter value={100} /></>}
        <div className="list" data-testid="playlist">
          {(s.transport?.playlist ?? []).map((t, i) => (
            <div className="list-item" key={t.id}>
              <div className="grow">
                <div style={{ color: i === s.transport?.trackIndex ? 'var(--ok)' : undefined }}>
                  {String(i + 1).padStart(2, '0')}. {t.title}
                </div>
                <div className="tiny">{t.artist} · {fmtTime(t.duration)}</div>
              </div>
              <button className="icon-btn" onClick={() => c?.playTrack(t.id)}>▶</button>
              <button className="icon-btn" onClick={() => c?.move(i, -1)}>↑</button>
              <button className="icon-btn" onClick={() => c?.move(i, +1)}>↓</button>
              <button className="icon-btn" onClick={() => c?.remove(t.id)}>✕</button>
            </div>
          ))}
          {(s.transport?.playlist ?? []).length === 0 && (
            <div className="dim" style={{ padding: '14px 0' }}>No songs yet — add an MP3, M4A or WAV.</div>
          )}
        </div>
        <Row style={{ marginTop: 10 }}>
          <span className="dim">Auto next</span>
          <button
            className={`chip ${s.transport?.autoNext ? 'active' : ''}`}
            onClick={() => c?.autoNext(!s.transport?.autoNext)}
          >{s.transport?.autoNext ? 'On' : 'Off'}</button>
        </Row>
      </Card>

      <Card>
        <Row>
          <div className="kicker">Speakers</div>
          <span className="dim mono">{s.speakerCount} connected</span>
        </Row>
        <div className="list scroll">
          {s.speakers.map((sp) => (
            <div className="list-item" key={sp.id}>
              <div className="grow">
                <div>{sp.name}</div>
                <div className="tiny">{sp.group} · {sp.status}</div>
              </div>
              <span className="dim mono">{Math.round(sp.latencyMs)}ms</span>
              <span className="mono" style={{ color: Math.abs(sp.driftMs) < 50 ? 'var(--ok)' : 'var(--warn)' }}>
                {Math.round(sp.driftMs)}ms
              </span>
            </div>
          ))}
          {s.speakers.length === 0 && <div className="dim" style={{ padding: '14px 0' }}>Waiting for speakers…</div>}
        </div>
        {s.truncated && <div className="tiny">Showing the first page — the count above is the full total.</div>}
        <div style={{ height: 10 }} />
        <div className="chip-row">
          {['ALL', 'GROUP A', 'GROUP B'].map((g) => (
            <button key={g} className="chip" onClick={() => c?.muteGroup(g, true)}>Mute {g}</button>
          ))}
          {['ALL', 'GROUP A', 'GROUP B'].map((g) => (
            <button key={'u' + g} className="chip" onClick={() => c?.muteGroup(g, false)}>Unmute {g}</button>
          ))}
        </div>
        <div className="tiny" style={{ marginTop: 8 }}>
          Drift is measured, not guaranteed — wireless playback is never perfectly identical.
        </div>
      </Card>

      {(s.error || s.info) && (
        <Card>
          {s.error && <div className="err-text">{s.error}</div>}
          {s.info && <div className="warn-text">{s.info}</div>}
        </Card>
      )}

      <Button variant="danger" onClick={() => c?.end()}>END SESSION</Button>
      <button className="chip" style={{ alignSelf: 'center' }} onClick={() => go('/')}>← Home</button>
    </Shell>
  );
}
