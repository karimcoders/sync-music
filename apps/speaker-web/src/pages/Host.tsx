import { useEffect, useMemo, useRef, useState } from 'react';
import { HostClient, type HostState } from '../lib/hostClient';
import { P2PHostClient } from '../lib/p2p/p2pHost';
import { detectMode, type Mode } from '../lib/mode';
import { backendOrigin } from '../lib/backend';
import JoinCard from '../components/JoinCard';
import { lock } from '../lib/auth';
import { acquireHost, shutdownHost } from '../lib/p2p/hostSingleton';
import { videoIdFrom } from '../lib/audio/youtube';
import { AppBar, Artwork, Button, Card, Icons, Equalizer, Field, Logo, Meter, Row, RoundBtn, Scrubber, Shell, Stack, Status, fmtTime , useMood } from '../ui';

type AnyHost = HostClient | P2PHostClient;

export default function Host({ go }: { go: (p: string) => void }) {
  const [s, setS] = useState<HostState | null>(null);
  const [yt, setYt] = useState('');
  const [ytErr, setYtErr] = useState<string | null>(null);
  useMood(!s?.sessionId ? 'idle' : s.error ? 'trouble' : s.transport?.state === 'playing' ? 'playing' : 'connected');
  const [mode, setMode] = useState<Mode | null>(null);
  const ref = useRef<AnyHost | null>(null);
  const [name, setName] = useState('My Music');
  const [seekPreview, setSeekPreview] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let disposed = false;
    let release = () => {};
    void detectMode().then((m) => {
      if (disposed) return;
      setMode(m);
      // The host (the room itself) lives in hostSingleton, NOT in this page.
      // The page used to dispose it on unmount, and disposing destroys the
      // peer: the moment the host tapped MIXER / SPEAKER / SOUND the room
      // vanished and every phone dropped out of it.
      const { client, fresh, release: off } = acquireHost(m, (st) => setS({ ...st }));
      const c = client as AnyHost;
      release = off;
      ref.current = c;
      (window as any).__syncHost = c; // diagnostics / e2e only
      setS({ ...c.state });
      if (fresh) {
        const saved = c.saved;
        if (saved) c.attach(saved.sessionId, saved.token); // survives a refresh
      }
    });
    return () => { disposed = true; release(); };
  }, []);

  const c = ref.current;
  const link = c instanceof P2PHostClient
    ? c.speakerUrl
    : `${location.origin}${import.meta.env.BASE_URL}speaker?s=${s?.sessionId ?? ''}&go=1`;
  const joinCode = c instanceof P2PHostClient
    ? c.joinCode
    : (s?.sessionId ? s.sessionId.slice(0, 6).toUpperCase() : undefined);
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
      <Shell tab="host" go={go}>
        <AppBar title="Player" sub="Host" />
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
          <div className="kicker">{mode === 'direct' ? 'Direct mode — no server' : 'Heads up'}</div>
          {mode === 'direct' && (
            <p className="tiny">
              No backend was found, so this tab will be the server: phones connect straight to it
              over WebRTC and the track is sent to each of them from here. Keep this tab open and
              the screen awake — if it closes, playback stops. A real backend (see the README)
              is steadier for many phones and large files.
            </p>
          )}
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
    <Shell tab="host" go={go}>
      <AppBar title={s.sessionName || 'Player'} sub="Host" />

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
        {backendOrigin && <div className="tiny" style={{ marginTop: 6 }}>Server: {backendOrigin}</div>}
      </Card>

      <JoinCard link={link} code={joinCode} />

      <Card className="deck">
        <Artwork title={track?.title ?? 'Sync Music'} playing={!!c?.playing} />
        <div className="deck-title">
          <div className="kicker">{c?.playing ? 'Now playing' : 'Paused'}</div>
          <h2 data-testid="now-title">{track ? track.title : 'No song selected'}</h2>
          <div className="dim">{track ? track.artist : 'Add a song below to get started'}</div>
        </div>
        <Scrubber
          value={pos} max={dur} disabled={!track}
          onPreview={setSeekPreview}
          onCommit={() => { if (seekPreview != null) c?.seek(seekPreview); setSeekPreview(null); }}
        />
        <Row>
          <span className="dim mono">{fmtTime(pos)}</span>
          <span className="dim mono">-{fmtTime(Math.max(0, dur - pos))}</span>
        </Row>
        {c instanceof P2PHostClient && (
          <Row style={{ marginTop: 12 }}>
            <span className="dim">Live microphone</span>
            <button
              className={`chip ${s.micOn ? 'active' : ''}`} data-testid="mic"
              onClick={() => void c.toggleMic()}
            >{s.micOn ? 'On air' : 'Off'}</button>
          </Row>
        )}
        {c instanceof P2PHostClient && s.micOn && (
          <div className="tiny" style={{ marginTop: 6 }}>
            Your voice goes straight to every speaker over WebRTC — roughly 100–250 ms behind,
            so it is a PA, not a sample-accurate second channel. Keep the phones apart or you
            will get feedback.
          </div>
        )}
        {c instanceof P2PHostClient && (
          <Row style={{ marginTop: 12 }}>
            <span className="dim">Play on this phone too</span>
            <button
              className={`chip ${c.localAudioOn ? 'active' : ''}`}
              data-testid="host-audio"
              onClick={() => { c.setLocalAudio(!c.localAudioOn); setS({ ...c.state }); }}
            >{c.localAudioOn ? 'On' : 'Off'}</button>
          </Row>
        )}
        <div className="transport">
          <RoundBtn label="Stop" onClick={() => c?.stop()}>{Icons.stop}</RoundBtn>
          <RoundBtn label="Previous track" onClick={() => c?.prev()}>{Icons.prev}</RoundBtn>
          <RoundBtn
            label={c?.playing ? 'Pause' : 'Play'} size="lg" testId="play"
            disabled={(s.transport?.playlist.length ?? 0) === 0}
            onClick={() => c?.toggle()}
          >{c?.playing ? Icons.pause : Icons.play}</RoundBtn>
          <RoundBtn label="Next track" onClick={() => c?.next()}>{Icons.next}</RoundBtn>
          <RoundBtn label="Resync every speaker" onClick={() => c?.resync()}>{Icons.resync}</RoundBtn>
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

      <CloudCard host={c} />

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
        {s.delivery && s.delivery.phase !== 'done' && (
          <div style={{ marginTop: 10 }}>
            <Row>
              <div className="tiny">
                {s.delivery.phase === 'uploading' ? `Uploading to the cloud — ${s.delivery.pct}%`
                  : s.delivery.phase === 'delivering' ? 'Phones are downloading it'
                  : 'Sending straight to the phones'}
              </div>
              <div className="tiny dim" data-testid="delivery-note">{s.delivery.note}</div>
            </Row>
            <div style={{ height: 6 }} />
            <Meter value={s.delivery.phase === 'uploading' ? s.delivery.pct : 100} />
            <div className="tiny dim" style={{ marginTop: 6 }}>
              {s.speakers.filter((x: any) => x.ready).length}/{s.speakers.length} phone(s) have the song
            </div>
          </div>
        )}
        <div className="list" data-testid="playlist">
          {(s.transport?.playlist ?? []).map((t, i) => (
            <div className="list-item" key={t.id}>
              <div className="grow">
                <div style={{ color: i === s.transport?.trackIndex ? 'var(--ok)' : undefined }}>
                  {String(i + 1).padStart(2, '0')}. {t.title}
                </div>
                <div className="tiny">{t.artist} · {fmtTime(t.duration)}</div>
              </div>
              <button className="icon-btn" data-testid={`play-track-${i}`} onClick={() => c?.playTrack(t.id)}>▶</button>
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
        <div className="kicker">Play from YouTube</div>
        <p className="tiny" style={{ marginTop: 6 }}>
          Paste a YouTube link. Every phone opens that video itself and is held
          to the same second — the audio cannot be sent over the local link, so
          each phone streams its own copy and needs internet.
        </p>
        <Row style={{ marginTop: 10, gap: 8 }}>
          <input
            type="text" data-testid="yt-url" placeholder="https://youtu.be/…"
            value={yt} onChange={(e) => setYt(e.target.value)} style={{ flex: 1 }}
          />
          <Button
            testId="yt-play"
            onClick={() => {
              const id = videoIdFrom(yt);
              if (!id) { setYtErr('That does not look like a YouTube link.'); return; }
              setYtErr(null);
              (c as any)?.youtube?.(id, 0, true);
            }}
          >PLAY</Button>
        </Row>
        <Row style={{ marginTop: 8 }}>
          <a className="tiny" href="https://www.youtube.com/results?search_query=" target="_blank" rel="noreferrer">
            Search on YouTube ↗
          </a>
          {s.youtubeId && (
            <button className="chip" data-testid="yt-stop" onClick={() => (c as any)?.youtube?.(null)}>
              Stop the video
            </button>
          )}
        </Row>
        {ytErr && <div className="err-text" style={{ marginTop: 8 }}>{ytErr}</div>}
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
      <Row style={{ justifyContent: 'center', gap: 10 }}>
        <button className="chip" onClick={() => go('/')}>← Home</button>
        <button className="chip" data-testid="sign-out" onClick={() => { shutdownHost(); lock(); go('/'); }}>Sign out</button>
      </Row>
      <div className="footer-note">build {__BUILD__}</div>
    </Shell>
  );
}

/**
 * Fast delivery.
 *
 * Without it this phone uploads the same song once per speaker over its own
 * connection, which is why a phone can sit at "Getting the new song… 51 %".
 * With it the song is uploaded ONCE to a GitHub branch and every speaker
 * downloads it from GitHub's servers in parallel, at its own full speed.
 *
 * The token is typed in here and stays in this phone's browser storage. It is
 * never put in the app, never sent to a speaker, and never shown to anybody
 * who opens the speaker page.
 */
function CloudCard({ host }: { host: any }) {
  const saved = host?.cloudConfig ?? null;
  const [open, setOpen] = useState(false);
  const [repo, setRepo] = useState(saved?.repo ?? 'karimcoders/sync-music');
  const [token, setToken] = useState('');
  const on = !!host?.cloudReady;
  if (!host?.setCloud) return null;

  return (
    <Card>
      <Row>
        <div className="kicker">Fast delivery {on ? '· ON' : '· OFF'}</div>
        <button className="chip" onClick={() => setOpen((v) => !v)} data-testid="cloud-toggle">
          {open ? 'Close' : on ? 'Change' : 'Set up'}
        </button>
      </Row>
      <div className="tiny" style={{ marginTop: 8 }}>
        {on
          ? 'Songs are uploaded once and every phone downloads its own copy directly — no waiting for this phone to send it to each one.'
          : 'Right now this phone sends the whole song separately to every speaker, so more phones means a longer wait. Turn this on to upload each song once instead.'}
      </div>
      {open && (
        <Stack>
          <div style={{ height: 10 }} />
          <Field label="Repository (owner/name)">
            <input value={repo} onChange={(e) => setRepo(e.target.value)} data-testid="cloud-repo" />
          </Field>
          <Field label="GitHub token with write access">
            <input
              type="password" value={token} placeholder={on ? '•••••••• (saved)' : 'ghp_…'}
              onChange={(e) => setToken(e.target.value)} data-testid="cloud-token"
            />
          </Field>
          <div className="tiny">
            Honest about this: the songs become public files at a public link that
            anyone can download, and the token is stored in THIS phone's browser.
            If the upload ever fails, nothing breaks — the phones simply get the
            song the slower way.
          </div>
          <Row>
            <Button
              testId="cloud-save"
              onClick={() => {
                host.setCloud({ repo: repo.trim(), branch: 'audio-cdn', token: token.trim() || saved?.token || '' });
                setToken(''); setOpen(false);
              }}
            >Save</Button>
            {on && <Button variant="ghost" onClick={() => { host.setCloud(null); setOpen(false); }}>Turn off</Button>}
          </Row>
        </Stack>
      )}
    </Card>
  );
}
