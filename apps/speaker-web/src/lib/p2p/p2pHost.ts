import Peer, { DataConnection } from 'peerjs';
import { AudioTrack, SpeakerInfo, SYNC, TransportState } from '@sync-music/protocol';
import { projectPosition } from '@sync-music/sync-engine';
import type { HostState } from '../hostClient';
import { P2PMessage, PEER_OPTIONS, codeFromRoomId, newRoomCode, roomIdFromCode } from './messages';
import { allTracks, clearTracks, deleteTrack, putTrack } from './trackStore';

/**
 * Direct-mode host: this browser tab IS the server.
 *
 * It owns the authoritative clock and transport, keeps one WebRTC data channel
 * per speaker, answers their clock-sync probes, ships the audio bytes to each
 * of them, and aggregates their telemetry — exactly the responsibilities the
 * Node backend has in the normal mode, which is why it can expose the same
 * HostState to the UI.
 *
 * No maximum speaker count is imposed here either; the real ceiling is how many
 * data channels this phone's browser and uplink can carry.
 */

interface Conn {
  conn: DataConnection;
  info: SpeakerInfo;
  /** tracks whose bytes this speaker already has */
  sent: Set<string>;
  /** last time we pushed a repair snapshot to this speaker */
  lastRepair: number;
  sending?: boolean;
}

const STORE = 'sync-music.p2phost';

export class P2PHostClient {
  private peer: Peer | null = null;
  private conns = new Map<string, Conn>();
  private files = new Map<string, { track: AudioTrack; bytes: ArrayBuffer; mime: string }>();
  private timers: number[] = [];
  private seq = 0;           // ids for uploaded tracks
  /**
   * Monotonic transport counter. Seeded from the clock so that it keeps
   * increasing even after the host tab is refreshed — speakers that survived
   * the refresh must not mistake a new command for an old one.
   */
  private cmdSeq = Date.now();
  private roomId = '';

  state: HostState = {
    conn: 'offline', sessionId: null, sessionName: '', speakerCount: 0, speakers: [],
    truncated: false, avgDriftMs: 0, avgLatencyMs: 0, transport: null, position: 0,
    uploading: false, busy: false, error: null, info: null,
  };

  private transport: TransportState = {
    state: 'idle', trackId: null, position: 0, positionAtServerTime: Date.now(),
    volume: 1, playlist: [], trackIndex: -1, autoNext: true,
  };

  /** peers whose one-way latency we have actually measured */
  private latency = new Map<string, number>();
  /** peers that told us their own clock estimate has settled */
  private clockReady = new Map<string, boolean>();

  constructor(private onChange: (s: HostState) => void) {
    this.timers.push(window.setInterval(() => this.tick(), 250));
    // Measure every speaker's latency ourselves — the correction loop below is
    // only trustworthy if the round-trip is known on THIS clock.
    this.timers.push(window.setInterval(() => this.broadcast({ type: 'PING', t1: Date.now() }), 2000));
  }

  private set(p: Partial<HostState>) { this.state = { ...this.state, ...p }; this.onChange(this.state); }
  private pushTransport() { this.set({ transport: { ...this.transport } }); }

  /** Link the speakers open — carries the room, so nothing has to be typed. */
  get speakerUrl() {
    const base = `${location.origin}${import.meta.env.BASE_URL.replace(/\/$/, '')}`;
    return `${base}/#/speaker?h=${this.roomId}&go=1`;
  }

  /** Short code for anyone who would rather type than open a link. */
  get joinCode() { return codeFromRoomId(this.roomId).toUpperCase(); }

  /**
   * A direct-mode room now survives a refresh: the room id lives in
   * localStorage and the audio in IndexedDB, so the tab can re-open the SAME
   * PeerJS id and the speakers reconnect by themselves.
   */
  get saved(): { sessionId: string; token: string } | null {
    try {
      const v = JSON.parse(localStorage.getItem(STORE) || 'null');
      return v?.roomId ? { sessionId: v.roomId, token: v.name ?? '' } : null;
    } catch { return null; }
  }

  /* ------------------------------ lifecycle ----------------------------- */

  async createSession(name: string) {
    this.set({ busy: true, error: null, info: 'Opening a direct room…' });
    this.roomId = roomIdFromCode(newRoomCode());
    try {
      await this.openPeer(this.roomId);
      this.transport = { ...this.transport, state: 'idle', positionAtServerTime: Date.now() };
      this.set({
        sessionId: this.roomId, sessionName: name, conn: 'connected',
        info: 'Direct mode — no server involved.',
      });
      this.pushTransport();
      localStorage.setItem(STORE, JSON.stringify({ roomId: this.roomId, name }));
      void clearTracks(); // a brand-new room starts with an empty library
    } catch (e: any) {
      this.set({ error: e?.message || 'Could not open a direct room. Check your internet connection.' });
    } finally { this.set({ busy: false }); }
  }

  /**
   * Re-open a room after a page refresh: same id, playlist restored from
   * IndexedDB. Speakers are already retrying, so they come back on their own.
   */
  async attach(roomId: string, name = '') {
    this.roomId = roomId;
    this.set({ busy: true, conn: 'connecting', sessionName: name, info: 'Re-opening your room…' });
    try {
      await this.openPeer(roomId, 4);
      const stored = await allTracks();
      if (stored.length) {
        const playlist: AudioTrack[] = stored.map((t) => {
          this.files.set(t.id, { track: null as any, bytes: t.bytes, mime: t.mimeType });
          const track: AudioTrack = {
            id: t.id, title: t.title, artist: t.artist, filename: t.filename, mimeType: t.mimeType,
            size: t.size, duration: t.duration, createdAt: Date.now(),
            url: URL.createObjectURL(new Blob([t.bytes], { type: t.mimeType })),
          };
          this.files.set(t.id, { track, bytes: t.bytes, mime: t.mimeType });
          return track;
        });
        this.transport = { ...this.transport, playlist, trackIndex: 0, trackId: playlist[0].id };
      }
      this.set({
        sessionId: roomId, conn: 'connected',
        info: 'Room re-opened — speakers reconnect by themselves.',
      });
      this.pushTransport();
    } catch (e: any) {
      localStorage.removeItem(STORE);
      this.set({ sessionId: null, conn: 'offline', error: e?.message || 'Could not re-open that room.' });
    } finally { this.set({ busy: false }); }
  }

  private openPeer(id: string, retries = 0) {
    return new Promise<void>((resolve, reject) => {
      const peer = new Peer(id, PEER_OPTIONS);
      this.peer = peer;
      const fail = (e: any) => {
        // Right after a refresh the broker may still hold the old registration
        // for a few seconds — wait it out instead of losing the room.
        if (e?.type === 'unavailable-id' && retries > 0) {
          try { peer.destroy(); } catch {}
          window.setTimeout(() => this.openPeer(id, retries - 1).then(resolve, reject), 1500);
          return;
        }
        reject(new Error(e?.type === 'unavailable-id'
          ? 'That room id is taken, try again.'
          : 'Could not reach the connection broker.'));
      };
      peer.once('open', () => { peer.off('error', fail); resolve(); });
      peer.once('error', fail);
      peer.on('connection', (c) => this.accept(c));
      peer.on('disconnected', () => {
        this.set({ conn: 'reconnecting' });
        try { peer.reconnect(); } catch {}
      });
      peer.on('error', (e: any) => {
        // Per-connection errors must not kill the room.
        if (e?.type === 'peer-unavailable') return;
        if (e?.type === 'network') { this.set({ conn: 'reconnecting' }); return; }
        this.set({ error: `Connection error: ${e?.type ?? 'unknown'}` });
      });
    });
  }

  /* ------------------------------- speakers ----------------------------- */

  private accept(conn: DataConnection) {
    conn.on('open', () => {
      const n = this.conns.size + 1;
      const info: SpeakerInfo = {
        id: conn.peer, name: `Speaker ${n}`, group: 'ALL', status: 'connected', muted: false,
        latencyMs: 0, driftMs: 0, state: 'idle', bufferedSeconds: 0, joinedAt: Date.now(), lastSeen: Date.now(),
      };
      this.conns.set(conn.peer, { conn, info, sent: new Set(), lastRepair: 0 });
      this.send(conn, {
        type: 'WELCOME', speakerId: conn.peer, name: info.name,
        sessionName: this.state.sessionName, hostTime: Date.now(),
      });
      // Do NOT push the audio yet: a speaker that survived a host refresh
      // already has it, and re-sending would be a pointless megabyte (and
      // would replace the very blob it is playing from). Its first STATUS
      // tells us whether it needs the file.
      this.resyncOne(conn.peer);
      this.publishSpeakers();
    });

    conn.on('data', (d) => this.onData(conn.peer, d as P2PMessage));
    conn.on('close', () => {
      this.conns.delete(conn.peer); this.latency.delete(conn.peer); this.clockReady.delete(conn.peer);
      this.publishSpeakers();
    });
    conn.on('error', () => { this.conns.delete(conn.peer); this.publishSpeakers(); });
  }

  private onData(peerId: string, m: P2PMessage) {
    const c = this.conns.get(peerId);
    if (!c) return;
    switch (m.type) {
      case 'PING':
        // T2 = receive, T3 = send. Same four-timestamp exchange as the server.
        this.send(c.conn, { type: 'PONG', t1: m.t1, t2: Date.now(), t3: Date.now() });
        break;
      case 'HELLO':
        if (m.name) { c.info = { ...c.info, name: m.name }; this.publishSpeakers(); }
        break;
      case 'STATUS': {
        // strict: a settled data channel on the same LAN sits in the low ms range
        this.clockReady.set(peerId, !!m.clockSynced && m.clockRtt < 40 && m.clockSamples >= 10);
        const track = this.transport.playlist[this.transport.trackIndex];
        // Measure on OUR clock: the sample was taken one-way-latency ago.
        const lat = this.latency.get(peerId);
        const sampledAt = Date.now() - (lat ?? 0);
        const expected = projectPosition(
          this.transport.position, this.transport.positionAtServerTime, sampledAt,
          this.transport.state === 'playing', track?.duration || Infinity,
        );
        const drift = m.position - expected;
        c.info = {
          ...c.info,
          driftMs: Math.round(drift * 1000),
          state: m.playing ? 'playing' : 'paused',
          bufferedSeconds: m.buffered,
          status: 'connected',
          lastSeen: Date.now(),
        };
        this.publishSpeakers();

        // --- repair: a speaker may have missed a command or the audio itself
        const want = track?.id ?? null;
        if (want && m.haveTrack !== want && !c.sending) {
          c.sending = true;
          void this.pushTrackTo(peerId).finally(() => {
            c.sending = false;
            this.sendState(peerId);
          });
        } else if (m.seq < this.cmdSeq && Date.now() - (c.lastRepair ?? 0) > 1500) {
          c.lastRepair = Date.now();
          this.sendState(peerId);
        }
        break;
      }
      case 'PONG': {
        // speakers answer our latency probe with the same four timestamps
        const rtt = Math.max(0, Date.now() - m.t1 - (m.t3 - m.t2));
        const prev = this.latency.get(peerId);
        // keep the optimistic estimate; jitter only ever inflates RTT
        const oneWay = rtt / 2;
        this.latency.set(peerId, prev === undefined ? oneWay : Math.min(prev * 0.9 + oneWay * 0.1, oneWay));
        c.info = { ...c.info, latencyMs: Math.round(this.latency.get(peerId)!) };
        break;
      }
    }
  }

  /** Full transport snapshot for one speaker (used to repair a laggard). */
  private sendState(peerId: string) {
    const c = this.conns.get(peerId);
    if (!c) return;
    const cur = this.transport.playlist[this.transport.trackIndex] ?? null;
    const pending = this.transport.positionAtServerTime > Date.now();
    const at = pending ? this.transport.positionAtServerTime : Date.now() + SYNC.APPLY_LEAD_MS;
    this.send(c.conn, {
      type: 'STATE',
      seq: this.cmdSeq,
      trackId: cur?.id ?? null,
      title: cur?.title ?? '',
      playing: this.transport.state === 'playing',
      position: pending ? this.transport.position : this.livePosition(at),
      atHostTime: at,
      volume: this.transport.volume,
    });
  }

  private publishSpeakers() {
    const speakers = [...this.conns.values()].map((c) => c.info);
    const drift = speakers.filter((s) => s.state === 'playing');
    this.set({
      speakers,
      speakerCount: speakers.length,
      truncated: false,
      avgDriftMs: drift.length ? Math.round(drift.reduce((a, s) => a + Math.abs(s.driftMs), 0) / drift.length) : 0,
      avgLatencyMs: speakers.length ? Math.round(speakers.reduce((a, s) => a + s.latencyMs, 0) / speakers.length) : 0,
    });
  }

  private send(conn: DataConnection, m: P2PMessage) {
    try { if (conn.open) conn.send(m); } catch {}
  }
  private broadcast(m: P2PMessage) { this.conns.forEach((c) => this.send(c.conn, m)); }

  /* -------------------------------- library ----------------------------- */

  async upload(file: File) {
    this.set({ uploading: true, error: null, info: 'Reading the file…' });
    try {
      const bytes = await file.arrayBuffer();
      const duration = await readDuration(file).catch(() => 0);
      const id = `t${++this.seq}-${Date.now().toString(36)}`;
      const track: AudioTrack = {
        id, title: file.name.replace(/\.[^.]+$/, ''), artist: 'Unknown artist',
        filename: file.name, mimeType: file.type || 'audio/mpeg', size: file.size,
        duration, url: URL.createObjectURL(file), createdAt: Date.now(),
      };
      this.files.set(id, { track, bytes, mime: track.mimeType });
      void putTrack({
        id, title: track.title, artist: track.artist, filename: track.filename,
        mimeType: track.mimeType, size: track.size, duration, bytes,
      });
      this.transport = { ...this.transport, playlist: [...this.transport.playlist, track] };
      if (this.transport.trackIndex < 0) this.transport = { ...this.transport, trackIndex: 0, trackId: id };
      this.pushTransport();
      this.set({ info: `Sending “${track.title}” to ${this.conns.size} phone(s)…` });
      await Promise.all([...this.conns.keys()].map((p) => this.pushTrackTo(p)));
      this.set({ info: 'Ready' });
    } catch (e: any) {
      this.set({ error: e?.message || 'Could not read that file.' });
    } finally { this.set({ uploading: false }); }
  }

  /**
   * Ship the current track to one speaker in paced 64 kB chunks.
   *
   * Handing PeerJS one multi-megabyte buffer blocks that data channel for
   * seconds: control messages queue up behind it and the phones that are still
   * downloading stutter. Pacing against `bufferedAmount` keeps the channel
   * responsive while the file streams.
   */
  private async pushTrackTo(peerId: string) {
    const c = this.conns.get(peerId);
    const cur = this.transport.playlist[this.transport.trackIndex];
    if (!c || !cur) return;
    const f = this.files.get(cur.id);
    if (!f || c.sent.has(cur.id)) return;
    c.sent.add(cur.id);

    const CHUNK = 64 * 1024;
    const total = Math.ceil(f.bytes.byteLength / CHUNK);
    this.send(c.conn, {
      type: 'TRACK_META', trackId: cur.id, title: cur.title, mime: f.mime,
      size: f.bytes.byteLength, chunks: total,
    });

    for (let i = 0; i < total; i++) {
      if (!this.conns.has(peerId) || !c.conn.open) { c.sent.delete(cur.id); return; }
      await this.waitForDrain(c.conn);
      this.send(c.conn, {
        type: 'TRACK_CHUNK', trackId: cur.id, index: i,
        bytes: f.bytes.slice(i * CHUNK, Math.min((i + 1) * CHUNK, f.bytes.byteLength)),
      });
    }
  }

  /** Back-pressure: never let more than ~512 kB sit in the send queue. */
  private waitForDrain(conn: DataConnection, limit = 512 * 1024) {
    const dc: RTCDataChannel | undefined = (conn as any).dataChannel;
    if (!dc || dc.bufferedAmount < limit) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const t = window.setInterval(() => {
        if (!conn.open || dc.bufferedAmount < limit) { window.clearInterval(t); resolve(); }
      }, 40);
    });
  }

  setPlaylist(ids: string[]) {
    const byId = new Map(this.transport.playlist.map((t) => [t.id, t]));
    const playlist = ids.map((i) => byId.get(i)).filter(Boolean) as AudioTrack[];
    const curId = this.transport.playlist[this.transport.trackIndex]?.id ?? null;
    const trackIndex = curId ? Math.max(0, playlist.findIndex((t) => t.id === curId)) : (playlist.length ? 0 : -1);
    this.transport = { ...this.transport, playlist, trackIndex, trackId: playlist[trackIndex]?.id ?? null };
    this.pushTransport();
  }
  move(index: number, delta: number) {
    const ids = this.transport.playlist.map((t) => t.id);
    const j = index + delta;
    if (j < 0 || j >= ids.length) return;
    ids.splice(j, 0, ids.splice(index, 1)[0]);
    this.setPlaylist(ids);
  }
  remove(id: string) {
    void deleteTrack(id);
    this.files.delete(id);
    this.setPlaylist(this.transport.playlist.map((t) => t.id).filter((x) => x !== id));
  }

  /* ------------------------------- transport ---------------------------- */

  get playing() { return this.transport.state === 'playing'; }
  get track(): AudioTrack | null {
    return this.transport.playlist[this.transport.trackIndex] ?? this.transport.playlist[0] ?? null;
  }

  play(trackId?: string, position = 0) {
    const idx = trackId
      ? this.transport.playlist.findIndex((t) => t.id === trackId)
      : (this.transport.trackIndex >= 0 ? this.transport.trackIndex : 0);
    const track = this.transport.playlist[idx];
    if (!track) return;
    const resume = !trackId && this.transport.state === 'paused' && idx === this.transport.trackIndex;
    const pos = resume ? this.transport.position : position;
    // A WebRTC data channel needs a few seconds before its clock-offset
    // estimate is any good, so give phones that just joined more head start.
    // Follow the speakers we really have instead of a fixed delay: a fresh
    // data channel needs more head start, a settled one needs very little.
    const cs = [...this.conns.values()];
    const worst = cs.reduce((a, c) => Math.max(a, this.latency.get(c.conn.peer) ?? 120), 0);
    // A phone whose own clock estimate has not settled yet would start at the
    // wrong moment, so wait for it instead of guessing from "time since join".
    const allReady = cs.length > 0 && cs.every((c) => this.clockReady.get(c.conn.peer));
    const lead = allReady ? Math.min(2000, Math.max(500, 350 + worst * 3)) : 2600;
    const startAt = Date.now() + lead;

    this.transport = {
      ...this.transport, state: 'playing', trackIndex: idx, trackId: track.id,
      position: pos, positionAtServerTime: startAt,
    };
    this.pushTransport();
    // make sure everybody has the bytes before the scheduled moment
    this.conns.forEach((_c, p) => void this.pushTrackTo(p));
    this.broadcast({ type: 'PLAY', seq: ++this.cmdSeq, trackId: track.id, position: pos, startAt });
  }

  pause() {
    if (this.transport.state !== 'playing') return;
    const pos = this.livePosition();
    this.transport = { ...this.transport, state: 'paused', position: pos, positionAtServerTime: Date.now() };
    this.pushTransport();
    this.broadcast({ type: 'PAUSE', seq: ++this.cmdSeq, position: pos });
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  stop() {
    this.transport = { ...this.transport, state: 'stopped', position: 0, positionAtServerTime: Date.now() };
    this.pushTransport();
    this.broadcast({ type: 'STOP', seq: ++this.cmdSeq });
  }

  seek(position: number) {
    const track = this.track;
    if (!track) return;
    const applyAt = Date.now() + SYNC.APPLY_LEAD_MS;
    this.transport = { ...this.transport, position, positionAtServerTime: applyAt };
    this.pushTransport();
    this.broadcast({ type: 'SEEK', seq: ++this.cmdSeq, trackId: track.id, position, applyAt });
  }

  next() { this.skip(1); }
  prev() { this.skip(-1); }
  private skip(d: number) {
    const i = this.transport.trackIndex + d;
    if (i < 0 || i >= this.transport.playlist.length) { this.stop(); return; }
    this.play(this.transport.playlist[i].id, 0);
  }
  playTrack(id: string) { this.play(id, 0); }

  volume(v: number) {
    this.transport = { ...this.transport, volume: v };
    this.pushTransport();
    this.broadcast({ type: 'VOLUME', seq: ++this.cmdSeq, volume: v });
  }

  resync() {
    const track = this.track;
    if (!track) return;
    const playing = this.transport.state === 'playing';
    const pending = this.transport.positionAtServerTime > Date.now();
    const at = pending ? this.transport.positionAtServerTime : Date.now() + SYNC.APPLY_LEAD_MS;
    this.broadcast({
      type: 'RESYNC', seq: ++this.cmdSeq, trackId: track.id,
      position: pending ? this.transport.position : this.livePosition(at), atHostTime: at, playing,
    });
  }
  private resyncOne(peerId: string) {
    const c = this.conns.get(peerId);
    const track = this.track;
    if (!c || !track) return;
    const pending = this.transport.positionAtServerTime > Date.now();
    const at = pending ? this.transport.positionAtServerTime : Date.now() + SYNC.APPLY_LEAD_MS;
    this.send(c.conn, {
      type: 'RESYNC', seq: this.cmdSeq, trackId: track.id,
      position: pending ? this.transport.position : this.livePosition(at),
      atHostTime: at, playing: this.transport.state === 'playing',
    });
    this.send(c.conn, { type: 'VOLUME', seq: this.cmdSeq, volume: this.transport.volume });
  }

  autoNext(enabled: boolean) { this.transport = { ...this.transport, autoNext: enabled }; this.pushTransport(); }
  muteGroup(_group: string, _muted: boolean) { /* groups are a server-mode feature */ }

  /* --------------------------------- misc -------------------------------- */

  private livePosition(at = Date.now()) {
    const track = this.transport.playlist[this.transport.trackIndex];
    return projectPosition(
      this.transport.position, this.transport.positionAtServerTime, at,
      this.transport.state === 'playing', track?.duration || Infinity,
    );
  }

  private tick() {
    if (!this.state.sessionId) return;
    const pos = this.livePosition();
    if (Math.abs(pos - this.state.position) > 0.05) this.set({ position: pos });

    const track = this.transport.playlist[this.transport.trackIndex];
    if (this.transport.state === 'playing' && track?.duration && pos >= track.duration - 0.15) {
      if (this.transport.autoNext && this.transport.trackIndex + 1 < this.transport.playlist.length) this.next();
      else this.stop();
    }
  }

  async end() {
    this.broadcast({ type: 'STOP', seq: ++this.cmdSeq });
    this.conns.forEach((c) => { try { c.conn.close(); } catch {} });
    this.conns.clear();
    try { this.peer?.destroy(); } catch {}
    localStorage.removeItem(STORE);
    void clearTracks();
    this.transport = { ...this.transport, state: 'idle', playlist: [], trackIndex: -1, trackId: null };
    this.set({ sessionId: null, transport: null, speakers: [], speakerCount: 0, conn: 'offline' });
  }

  dispose() {
    this.timers.forEach((t) => window.clearInterval(t));
    try { this.peer?.destroy(); } catch {}
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
