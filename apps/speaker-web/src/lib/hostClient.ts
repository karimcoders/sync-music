import { AudioTrack, ClientMessage, ServerMessage, SpeakerInfo, TransportState, safeParse } from '@sync-music/protocol';
import { ClockSync, projectPosition } from '@sync-music/sync-engine';
import { apiUrl, wsUrl } from './backend';

export type HostConn = 'offline' | 'connecting' | 'connected' | 'reconnecting';

export interface HostState {
  conn: HostConn;
  sessionId: string | null;
  sessionName: string;
  speakerCount: number;
  speakers: SpeakerInfo[];
  truncated: boolean;
  avgDriftMs: number;
  avgLatencyMs: number;
  transport: TransportState | null;
  position: number;
  uploading: boolean;
  busy: boolean;
  error: string | null;
  info: string | null;
  /** direct mode only: the host's microphone is live on every speaker */
  micOn?: boolean;
}

const STORE = 'sync-music.host';

/**
 * Browser host controller. Speaks exactly the same REST + WebSocket protocol
 * as the Android host app (apps/host-android) — including NTP-style clock sync
 * — so the sync behaviour you test here is the real thing.
 */
export class HostClient {
  private ws: WebSocket | null = null;
  private clock = new ClockSync();
  private token: string | null = null;
  private retry = 0;
  private closed = false;
  private timers: number[] = [];

  state: HostState = {
    conn: 'offline', sessionId: null, sessionName: '', speakerCount: 0, speakers: [],
    truncated: false, avgDriftMs: 0, avgLatencyMs: 0, transport: null, position: 0,
    uploading: false, busy: false, error: null, info: null,
  };

  constructor(private onChange: (s: HostState) => void) {
    const t = window.setInterval(() => this.tick(), 250);
    this.timers.push(t);
  }

  private set(p: Partial<HostState>) { this.state = { ...this.state, ...p }; this.onChange(this.state); }

  get saved() {
    try { return JSON.parse(localStorage.getItem(STORE) || 'null') as { sessionId: string; token: string } | null; }
    catch { return null; }
  }

  async createSession(name: string) {
    this.set({ busy: true, error: null });
    try {
      const r = await fetch(apiUrl('/api/session/create'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) throw new Error(r.status === 503 ? 'Server is at capacity. Try again later.' : `Server error ${r.status}`);
      const d = await r.json();
      localStorage.setItem(STORE, JSON.stringify({ sessionId: d.sessionId, token: d.hostToken }));
      this.attach(d.sessionId, d.hostToken);
    } catch (e: any) {
      this.set({ error: e.message || 'Unable to create session.' });
    } finally { this.set({ busy: false }); }
  }

  attach(sessionId: string, token: string) {
    this.token = token;
    this.closed = false;
    this.set({ sessionId, conn: 'connecting', error: null });
    this.connect();
  }

  private connect() {
    const ws = new WebSocket(wsUrl());
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.set({ conn: 'connected', info: null });
      this.send({ type: 'HOST_JOIN', sessionId: this.state.sessionId!, hostToken: this.token! });
      for (let i = 0; i < 5; i++) this.timers.push(window.setTimeout(() => this.probe(), i * 120));
      this.timers.push(window.setInterval(() => this.probe(), 15000));
    };
    ws.onmessage = (e) => {
      const m = safeParse<ServerMessage>(String(e.data));
      if (m) this.handle(m);
    };
    ws.onclose = () => {
      if (this.closed) { this.set({ conn: 'offline' }); return; }
      this.set({ conn: 'reconnecting' });
      this.retry++;
      window.setTimeout(() => this.connect(), Math.min(15000, 500 * 2 ** Math.min(this.retry, 5)));
    };
  }

  private probe() { this.send({ type: 'CLOCK_SYNC', clientTime: Date.now() }); }
  private send(m: ClientMessage) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m)); }

  private handle(m: ServerMessage) {
    switch (m.type) {
      case 'CLOCK_SYNC_REPLY': {
        const t4 = Date.now();
        this.clock.addSample(m.clientTime, m.serverReceiveTime, m.serverSendTime, t4);
        break;
      }
      case 'SESSION_STATE':
        this.set({
          sessionName: m.sessionName, speakerCount: m.speakerCount, transport: m.transport, error: null,
        });
        break;
      case 'SPEAKERS_SNAPSHOT':
        this.set({
          speakerCount: m.speakerCount, speakers: m.speakers, truncated: m.truncated,
          avgDriftMs: m.averageDriftMs, avgLatencyMs: m.averageLatencyMs,
        });
        break;
      case 'SESSION_ENDED':
        localStorage.removeItem(STORE);
        this.set({ sessionId: null, transport: null, speakers: [], speakerCount: 0, info: 'Session ended.' });
        break;
      case 'ERROR':
        if (m.code === 'SESSION_NOT_FOUND' || m.code === 'UNAUTHORIZED') {
          localStorage.removeItem(STORE);
          this.closed = true;
          try { this.ws?.close(); } catch {}
          this.set({ sessionId: null, error: 'That session has ended. Start a new one.' });
        } else this.set({ error: m.message });
        break;
    }
  }

  private tick() {
    const t = this.state.transport;
    if (!t) return;
    const track = t.playlist[t.trackIndex];
    const pos = projectPosition(
      t.position, t.positionAtServerTime, this.clock.now(), t.state === 'playing', track?.duration || Infinity,
    );
    if (Math.abs(pos - this.state.position) > 0.05) this.set({ position: pos });
  }

  /* ----------------------------- controls ------------------------------ */
  get playing() { return this.state.transport?.state === 'playing'; }
  /** Current track, or the one PLAY would start with (the first in the list). */
  get track(): AudioTrack | null {
    const t = this.state.transport;
    if (!t) return null;
    return t.playlist[t.trackIndex] ?? t.playlist[0] ?? null;
  }
  play() { this.send({ type: 'HOST_PLAY' }); }
  pause() { this.send({ type: 'HOST_PAUSE' }); }
  toggle() { this.playing ? this.pause() : this.play(); }
  stop() { this.send({ type: 'HOST_STOP' }); }
  next() { this.send({ type: 'HOST_NEXT' }); }
  prev() { this.send({ type: 'HOST_PREV' }); }
  seek(position: number) { this.send({ type: 'HOST_SEEK', position }); }
  volume(v: number) { this.send({ type: 'HOST_VOLUME', volume: v }); }
  resync() { this.send({ type: 'HOST_RESYNC_ALL' }); }
  autoNext(enabled: boolean) { this.send({ type: 'HOST_AUTO_NEXT', enabled }); }
  muteGroup(group: string, muted: boolean) { this.send({ type: 'HOST_MUTE_GROUP', group, muted }); }
  playTrack(id: string) { this.send({ type: 'HOST_PLAY', audioId: id, position: 0 }); }

  /* ------------------------------ library ------------------------------ */
  async upload(file: File) {
    const { sessionId } = this.state;
    if (!sessionId || !this.token) return;
    this.set({ uploading: true, error: null, info: 'Uploading…' });
    try {
      const duration = await readDuration(file).catch(() => 0);
      const fd = new FormData();
      fd.append('title', file.name.replace(/\.[^.]+$/, ''));
      fd.append('artist', 'Unknown artist');
      fd.append('duration', String(duration));
      fd.append('file', file, file.name);
      const r = await fetch(apiUrl(`/api/audio/upload?sessionId=${sessionId}`), {
        method: 'POST', headers: { Authorization: `Bearer ${this.token}` }, body: fd,
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Upload failed.');
      const ids = (this.state.transport?.playlist ?? []).map((t) => t.id).concat(d.id);
      await this.setPlaylist(ids);
      this.set({ info: 'Ready' });
    } catch (e: any) {
      this.set({ error: e.message || 'Upload failed.' });
    } finally { this.set({ uploading: false }); }
  }

  async setPlaylist(ids: string[]) {
    const { sessionId } = this.state;
    if (!sessionId || !this.token) return;
    const r = await fetch(apiUrl(`/api/session/${sessionId}/playlist`), {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ trackIds: ids }),
    });
    if (!r.ok) { this.set({ error: 'Could not update the playlist.' }); return; }
    const d = await r.json();
    if (this.state.transport) {
      this.set({ transport: { ...this.state.transport, playlist: d.playlist } });
    }
  }

  move(index: number, delta: number) {
    const ids = (this.state.transport?.playlist ?? []).map((t) => t.id);
    const j = index + delta;
    if (j < 0 || j >= ids.length) return;
    ids.splice(j, 0, ids.splice(index, 1)[0]);
    void this.setPlaylist(ids);
  }
  remove(id: string) {
    void this.setPlaylist((this.state.transport?.playlist ?? []).map((t) => t.id).filter((x) => x !== id));
  }

  async end() {
    const { sessionId } = this.state;
    if (sessionId && this.token) {
      await fetch(apiUrl(`/api/session/${sessionId}`), {
        method: 'DELETE', headers: { Authorization: `Bearer ${this.token}` },
      }).catch(() => {});
    }
    localStorage.removeItem(STORE);
    this.closed = true;
    try { this.ws?.close(); } catch {}
    this.set({ sessionId: null, transport: null, speakers: [], speakerCount: 0, conn: 'offline' });
  }

  dispose() {
    this.closed = true;
    this.timers.forEach((t) => { window.clearInterval(t); window.clearTimeout(t); });
    try { this.ws?.close(); } catch {}
  }
}

function readDuration(file: File): Promise<number> {
  return new Promise((res, rej) => {
    const a = new Audio();
    a.preload = 'metadata';
    a.onloadedmetadata = () => { res(a.duration || 0); URL.revokeObjectURL(a.src); };
    a.onerror = rej;
    a.src = URL.createObjectURL(file);
  });
}
