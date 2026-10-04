import Peer, { DataConnection, MediaConnection } from 'peerjs';
import { AudioTrack, SpeakerInfo, SYNC, TransportState } from '@sync-music/protocol';
import { projectPosition } from '@sync-music/sync-engine';
import type { HostState } from '../hostClient';
import { BROKERS, FIXED_ROOM_ID, P2PMessage, ROOM_SLOTS, codeFromRoomId, newRoomCode, peerOptions, roomIdFromCode } from './messages';
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
  /** tracks we have started (or finished) sending to this speaker */
  sent: Set<string>;
  /** tracks this speaker has CONFIRMED it holds (TRACK_READY / STATUS / HELLO) */
  have: Set<string>;
  /** when the last full transfer of a track to this speaker finished */
  doneAt: Record<string, number>;
  /** last time we pushed a repair snapshot to this speaker */
  lastRepair: number;
  repairing?: boolean;
  lastBias?: number;
  lastErr?: number;
}

/** One transfer. Several callers asking for the same file share one job. */
interface Job { trackId: string; force: boolean; waiters: Array<() => void> }
/** Per-phone send queue: a priority lane for the song being played, and a background lane. */
interface Outbox { urgent: Job[]; normal: Job[]; running: boolean; current: Job | null }

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
  /** the host's own speaker output (optional, on by default) */
  private local: HTMLAudioElement | null = null;
  private localTimer = 0;
  private localWanted = (localStorage.getItem('sm.hostAudio') ?? '1') === '1';

  /** peers that told us their own clock estimate has settled */
  private clockReady = new Map<string, boolean>();

  constructor(private onChange: (s: HostState) => void) {
    this.timers.push(window.setInterval(() => this.tick(), 250));
    // Measure every speaker's latency ourselves — the correction loop below is
    // only trustworthy if the round-trip is known on THIS clock.
    this.timers.push(window.setInterval(() => this.broadcast({ type: 'PING', t1: Date.now() }), 2000));
    this.timers.push(window.setInterval(() => this.reapSilentPeers(), 5000));
  }

  /**
   * Forget phones that stopped answering.
   *
   * The room id is fixed and the broker is public, so a tab that was closed
   * badly — or someone else's stale entry — can linger as an "open"
   * connection. PeerJS does not reliably report a close. Left alone they are
   * counted as speakers, and worse, every song is streamed to them, which
   * starves the phones that are really in the room.
   *
   * Everyone answers our PING every 2 s, so 15 s of silence means gone.
   */
  private reapSilentPeers() {
    const now = Date.now();
    [...this.conns.entries()].forEach(([peerId, c]) => {
      // a channel that opened but never introduced itself is a spare dial
      const introduced = this.deviceOf.has(peerId);
      const last = c.info?.lastSeen ?? 0;
      const quiet = now - last;
      if (introduced ? quiet < 15000 : quiet < 10000) return;
      try { c.conn.close(); } catch {}
      this.conns.delete(peerId);
      this.deviceOf.delete(peerId);
      this.sending.delete(peerId);
      this.outbox.delete(peerId);
      this.clockReady.delete(peerId);
      this.latency.delete(peerId);
      this.publishSpeakers();
    });
  }

  private set(p: Partial<HostState>) { this.state = { ...this.state, ...p }; this.onChange(this.state); }
  private pushTransport() {
    this.set({ transport: { ...this.transport } });
    // the "what comes next" hint must follow every playlist/track change,
    // otherwise phones decode ahead for a song that is no longer next
    this.hintNext();
  }

  /** Link the speakers open — carries the room, so nothing has to be typed. */
  get speakerUrl() {
    const base = `${location.origin}${import.meta.env.BASE_URL.replace(/\/$/, '')}`;
    // The room is permanent, so the link carries no session at all: it is the
    // same URL today and next week, which is what makes a printed QR work.
    return ROOM_SLOTS.includes(this.roomId) ? `${base}/#/speaker` : `${base}/#/speaker?h=${this.roomId}&go=1`;
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
      if (v?.roomId && typeof v.broker === 'number') this.broker = v.broker;
      return v?.roomId ? { sessionId: v.roomId, token: v.name ?? '' } : null;
    } catch { return null; }
  }

  /* ------------------------------ lifecycle ----------------------------- */

  async createSession(name: string) {
    this.set({ busy: true, error: null, info: 'Opening your room…' });
    // ONE permanent room: the same link and the same QR code work forever,
    // and nothing new has to be shared every time.
    try {
      // Take the first free slot. All of them are behind the same shared link.
      let last: any = null;
      let opened = false;
      outer:
      for (let b = 0; b < BROKERS.length; b++) {
        // Four slots at a time: trying them one by one took a quarter of a
        // minute whenever the broker still held a few stale ids.
        for (let i = 0; i < ROOM_SLOTS.length; i += 4) {
          this.set({ info: 'Opening your room…' });
          const batch = ROOM_SLOTS.slice(i, i + 4);
          try {
            const slot = await this.openFirstFree(batch, b);
            this.roomId = slot; this.broker = b; opened = true; break outer;
          } catch (e) { last = e; }
        }
      }
      if (!opened) {
        // Every shared slot is held (the public broker keeps an id reserved
        // for a while after a host leaves). Rather than refuse to start, open
        // a private room — the invite card then shows a link that carries it.
        this.roomId = roomIdFromCode(newRoomCode());
        try {
          await this.openPeer(this.roomId, 1, this.broker);
          opened = true;
          this.set({ info: 'The shared link was busy, so this session has its own link — share the one below.' });
        } catch { throw last ?? new Error('Could not open the room.'); }
      }
      this.transport = { ...this.transport, state: 'idle', positionAtServerTime: Date.now() };
      this.set({
        sessionId: this.roomId, sessionName: name, conn: 'connected',
        info: 'Direct mode — no server involved.',
      });
      this.pushTransport();
      localStorage.setItem(STORE, JSON.stringify({ roomId: this.roomId, name, broker: this.broker }));

    } catch (e: any) {
      this.set({
        error: e?.message?.includes('taken')
          ? 'Every room slot is busy. Close any other host tab on this link and try again in a minute.'
          : (e?.message || 'Could not open the room. Check your internet connection.'),
      });
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
      try {
        await this.openPeer(roomId, 3, this.broker);
      } catch {
        // The broker may hold our old slot for a while after the refresh.
        // Any other slot behind the same link is just as good — the speakers
        // scan the list, so they will find us there.
        let opened = false;
        for (let b = 0; b < BROKERS.length && !opened; b++) {
          for (let i = 0; i < ROOM_SLOTS.length && !opened; i += 4) {
            const batch = ROOM_SLOTS.slice(i, i + 4).filter((x) => x !== roomId);
            if (!batch.length) continue;
            try { this.roomId = roomId = await this.openFirstFree(batch, b); opened = true; } catch {}
          }
        }
        if (!opened) throw new Error('Could not re-open your room.');
        localStorage.setItem(STORE, JSON.stringify({ roomId: this.roomId, name, broker: this.broker }));
      }
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

  private broker = 0;

  /**
   * Open whichever of these slots is free, racing them. Losing peers are
   * destroyed immediately so we never hold a room we are not using.
   */
  private async openFirstFree(slots: string[], broker: number): Promise<string> {
    const peers: Peer[] = [];
    const winner = await new Promise<{ slot: string; peer: Peer } | null>((resolve) => {
      let pending = slots.length;
      let done = false;
      slots.forEach((slot) => {
        const peer = new Peer(slot, peerOptions(broker));
        peers.push(peer);
        const give_up = window.setTimeout(() => settle(null), 7000);
        const settle = (win: { slot: string; peer: Peer } | null) => {
          window.clearTimeout(give_up);
          if (done) return;
          if (win) { done = true; resolve(win); return; }
          if (--pending === 0) { done = true; resolve(null); }
        };
        peer.once('open', () => settle({ slot, peer }));
        peer.once('error', () => settle(null));
      });
    });
    peers.forEach((p) => { if (p !== winner?.peer) { try { p.destroy(); } catch {} } });
    if (!winner) throw new Error('Could not reach the connection broker.');
    this.adopt(winner.peer);
    return winner.slot;
  }

  /** Wire the handlers an already-open peer needs. */
  private adopt(peer: Peer) {
    this.peer = peer;
    peer.on('connection', (c) => this.accept(c));
    peer.on('disconnected', () => {
      this.set({ conn: 'reconnecting' });
      try { peer.reconnect(); } catch {}
    });
    peer.on('error', (e: any) => {
      if (e?.type === 'peer-unavailable') return;
      if (e?.type === 'network') { this.set({ conn: 'reconnecting' }); return; }
      this.set({ error: `Connection error: ${e?.type ?? 'unknown'}` });
    });
  }

  private openPeer(id: string, retries = 0, broker = this.broker) {
    this.broker = broker;
    return new Promise<void>((resolve, reject) => {
      const peer = new Peer(id, peerOptions(broker));
      // Bound every attempt: walking a dozen slots is only quick if a dead
      // broker cannot hold us for a minute.
      const give_up = window.setTimeout(() => {
        try { peer.destroy(); } catch {}
        reject(new Error('The connection broker did not answer.'));
      }, 7000);
      this.peer = peer;
      const fail = (e: any) => {
        window.clearTimeout(give_up);
        // Right after a refresh the broker may still hold the old registration
        // for a few seconds — wait it out instead of losing the room.
        if (e?.type === 'unavailable-id' && retries > 0) {
          // The broker holds a room id for a while after the previous host
          // tab closed or refreshed. Wait it out — this is the normal path
          // when you reopen the host page, not an error.
          try { peer.destroy(); } catch {}
          this.set({ info: `Your room is still held by the previous session — reclaiming it… (${retries})` });
          window.setTimeout(() => this.openPeer(id, retries - 1, broker).then(resolve, reject), 2000);
          return;
        }
        reject(new Error(e?.type === 'unavailable-id'
          ? 'That room id is taken, try again.'
          : 'Could not reach the connection broker.'));
      };
      peer.once('open', () => { window.clearTimeout(give_up); peer.off('error', fail); resolve(); });
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
      this.conns.set(conn.peer, { conn, info, sent: new Set(), have: new Set(), doneAt: {}, lastRepair: 0 });
      this.send(conn, {
        type: 'WELCOME', speakerId: conn.peer, name: info.name,
        sessionName: this.state.sessionName, hostTime: Date.now(),
      });
      // Do NOT push the audio yet: a speaker that survived a host refresh
      // already has it, and re-sending would be a pointless megabyte (and
      // would replace the very blob it is playing from). Its first STATUS
      // tells us whether it needs the file.
      this.resyncOne(conn.peer);
      if (this.micStream) this.callPeer(conn.peer);   // late joiner gets the mic too
      this.publishSpeakers();
    });

    conn.on('data', (d) => this.onData(conn.peer, d as P2PMessage));
    // A speaker may briefly hold more than one channel to us (it dials every
    // room slot in parallel and keeps the first that opens). Only forget the
    // speaker when the channel that is actually registered goes away —
    // otherwise a losing duplicate would knock a live speaker off the list.
    const drop = () => {
      if (this.conns.get(conn.peer)?.conn !== conn) return;
      this.conns.delete(conn.peer); this.latency.delete(conn.peer); this.clockReady.delete(conn.peer);
      this.outbox.delete(conn.peer); this.sending.delete(conn.peer);
      this.publishSpeakers();
    };
    conn.on('close', drop);
    conn.on('error', drop);
  }

  private onData(peerId: string, m: P2PMessage) {
    const c = this.conns.get(peerId);
    if (!c) return;
    // ANY message proves the phone is alive. Only STATUS used to count, so a
    // phone busy downloading a song (STATUS delayed behind the chunks) could be
    // dropped by reapSilentPeers() in the middle of the transfer.
    c.info.lastSeen = Date.now();
    switch (m.type) {
      case 'PING':
        // T2 = receive, T3 = send. Same four-timestamp exchange as the server.
        this.send(c.conn, { type: 'PONG', t1: m.t1, t2: Date.now(), t3: Date.now() });
        break;
      case 'HELLO': {
        // One phone, one speaker.
        //
        // A joining phone dials several room slots at once (that is what
        // makes joining fast), and more than one of those dials can succeed.
        // Counting them separately inflated "Connected Speakers" and, far
        // worse, streamed the song several times to the same phone — which
        // is bandwidth the phones that really are in the room needed.
        this.deviceOf.set(peerId, m.deviceId);
        [...this.deviceOf.entries()].forEach(([other, dev]) => {
          if (other === peerId || dev !== m.deviceId) return;
          const dup = this.conns.get(other);
          if (dup) { try { dup.conn.close(); } catch {} }
          this.conns.delete(other);
          this.deviceOf.delete(other);
          this.sending.delete(other);
          this.outbox.delete(other);
          this.latency.delete(other);
          this.clockReady.delete(other);
        });
        if (m.name) { c.info = { ...c.info, name: m.name }; }
        this.publishSpeakers();
        // Everything this phone kept from an earlier session is a transfer we
        // do not have to make — that is what makes the next PLAY instant.
        (m.cached ?? []).forEach((id) => { c.sent.add(id); c.have.add(id); });
        this.prefetch(peerId);
        this.hintNext(peerId);
        this.sendYtTo(c.conn);
        break;
      }
      case 'STATUS': {
        (m.cached ?? []).forEach((id) => { c.sent.add(id); c.have.add(id); });
        if (m.haveTrack) c.have.add(m.haveTrack);
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

        // --- a phone whose own clock estimate is biased (asymmetric relay):
        // hand back half of the error we measured, at most once per 2 s.
        // NOTE: there used to be a CLOCK_BIAS loop here — the host handing a
        // speaker a correction for its own clock estimate. It made real phones
        // worse, not better: the host's own latency estimate is noisy, so the
        // correction chased that noise and the phones audibly wandered. The
        // speaker's own NTP-style exchange plus the drift policy is steadier.
        // Do not re-add it without an end-to-end measurement on real phones.

        // --- repair: a speaker may have missed a command or the audio itself
        const want = track?.id ?? null;
        if (want && m.haveTrack !== want) {
          // Sent, but never confirmed for 10 s: it did not land, so send it
          // again. Anything younger is probably still being assembled on the
          // phone — re-sending then would just burn the uplink.
          const done = c.doneAt[want] ?? 0;
          const stale = c.sent.has(want) && !c.have.has(want) && done > 0 && Date.now() - done > 10000;
          if (!c.repairing) {
            c.repairing = true;
            void this.enqueueTrack(peerId, want, { urgent: true, force: stale }).finally(() => {
              c.repairing = false;
              if (Date.now() - c.lastRepair > 1500) { c.lastRepair = Date.now(); this.sendState(peerId); }
            });
          }
        } else if (m.seq < this.cmdSeq && Date.now() - (c.lastRepair ?? 0) > 1500) {
          c.lastRepair = Date.now();
          this.sendState(peerId);
        }
        break;
      }
      case 'TRACK_READY':
        c.have.add(m.trackId);
        break;
      case 'TRACK_WANT': {
        // That phone is on a song it does not hold and cannot play anything
        // until it has the file. It jumps the queue, and our own "already
        // sent" bookkeeping is ignored — plainly it did not arrive. Asking
        // again while the file is already queued or streaming just joins that
        // transfer (no restart, no duplicate), and an echo of a transfer that
        // finished a moment ago is ignored.
        if (Date.now() - (c.doneAt[m.trackId] ?? 0) < 2000) break;
        c.have.delete(m.trackId);
        void this.enqueueTrack(peerId, m.trackId, { urgent: true, force: true });
        break;
      }
      case 'TRACK_NEED':
        void this.resendChunks(peerId, m.trackId, m.indexes);
        break;
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
    // A phone counts as a speaker once it has introduced itself. The spare
    // dials a joining phone makes can open a channel and never say HELLO;
    // showing those as extra speakers was simply wrong.
    const speakers = [...this.conns.entries()]
      .filter(([peerId]) => this.deviceOf.has(peerId))
      .map(([, c]) => c.info);
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
  /** set whenever a transport command is sent: transfers yield to it */
  private lastCommandAt = 0;

  /**
   * Transport commands are tiny and idempotent (the speaker ignores a `seq` it
   * has already applied), so we simply send each one three times a few tens of
   * ms apart. On a weak phone that turns "the command was lost, wait for the
   * next STATUS repair" into "it arrived".
   */
  private broadcastReliable(m: P2PMessage) {
    this.broadcast(m);
    [60, 220].forEach((d) => window.setTimeout(() => this.broadcast(m), d));
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
      this.conns.forEach((_c, p) => this.prefetch(p));
      if (this.transport.trackIndex < 0) this.transport = { ...this.transport, trackIndex: 0, trackId: id };
      this.pushTransport();
      this.set({ info: `Sending “${track.title}” to ${this.conns.size} phone(s)…` });
      this.hintNext();
      await Promise.all([...this.conns.keys()].map((p) => this.enqueueTrack(p, id)));
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
  /**
   * Transfers are serialised. The host has ONE uplink: sending the same file to
   * three phones at once simply makes all three slower, and the saturated
   * channels then delay the PLAY/PAUSE messages — which is exactly what the
   * stuttering felt like.
   */
  /**
   * One queue PER PHONE, not one global queue.
   *
   * The old single queue meant a slow phone downloading a 9 MB song blocked
   * every other phone's transfer behind it, so "switch song" took as long as
   * the slowest link times the number of phones. Each phone now drains its
   * own queue, and each queue has an urgent lane (the song being played) that
   * is served before the background prefetch.
   */
  private outbox = new Map<string, Outbox>();
  /** the file currently streaming to each phone */
  private sending = new Map<string, string>();
  /** which physical phone is behind each peer connection */
  private deviceOf = new Map<string, string>();

  /**
   * Ask for a file to go to a phone. Resolves when it has been sent (or when
   * it is clear it will not be). Asking twice for the same file joins the
   * existing job instead of starting a second copy.
   */
  private enqueueTrack(peerId: string, trackId?: string, opts: { urgent?: boolean; force?: boolean } = {}) {
    const id = trackId ?? this.transport.playlist[this.transport.trackIndex]?.id;
    if (!id) return Promise.resolve();
    const c = this.conns.get(peerId);
    if (!c) return Promise.resolve();
    if (!opts.force && c.sent.has(id)) return Promise.resolve();

    let box = this.outbox.get(peerId);
    if (!box) { box = { urgent: [], normal: [], running: false, current: null }; this.outbox.set(peerId, box); }

    // already queued? promote it if this request is the urgent one, and wait on it
    const found = [...box.urgent, ...box.normal].find((j) => j.trackId === id);
    if (found) {
      if (opts.urgent && !box.urgent.includes(found)) {
        box.normal.splice(box.normal.indexOf(found), 1);
        box.urgent.push(found);
      }
      found.force ||= !!opts.force;
      return new Promise<void>((r) => found.waiters.push(r));
    }
    // already streaming it? just wait for it to finish
    if (box.current?.trackId === id) return new Promise<void>((r) => box!.current!.waiters.push(r));

    const job: Job = { trackId: id, force: !!opts.force, waiters: [] };
    (opts.urgent ? box.urgent : box.normal).push(job);
    const done = new Promise<void>((r) => job.waiters.push(r));
    void this.drain(peerId);
    return done;
  }

  private async drain(peerId: string) {
    const box = this.outbox.get(peerId);
    if (!box || box.running) return;
    box.running = true;
    try {
      for (;;) {
        const job = box.urgent.shift() ?? box.normal.shift();
        if (!job) break;
        if (!this.conns.has(peerId)) { job.waiters.forEach((w) => w()); break; }
        box.current = job;
        try { await this.sendTrack(peerId, job.trackId, job.force); }
        catch { /* a dead connection must not wedge the queue */ }
        box.current = null;
        job.waiters.forEach((w) => w());
      }
    } finally {
      box.running = false;
      // a job added while we were on the last line would otherwise sit forever
      if (box.urgent.length || box.normal.length) void this.drain(peerId);
    }
  }

  /**
   * Tell every phone which song is next so it can decode it in the
   * background. Decoding a 4-minute MP3 costs a second or two on a cheap
   * phone; doing it BEFORE the switch is what makes the switch feel instant.
   */
  private hintNext(peerId?: string) {
    const pl = this.transport.playlist;
    const next = pl.length ? pl[(this.transport.trackIndex + 1) % pl.length]?.id ?? null : null;
    const targets = peerId ? [this.conns.get(peerId)].filter(Boolean) : [...this.conns.values()];
    targets.forEach((c) => { try { this.send(c!.conn, { type: 'NEXT_HINT', trackId: next }); } catch {} });
  }

  /** Re-send only the chunks a speaker reports as missing. */
  private async resendChunks(peerId: string, trackId: string, indexes: number[]) {
    const c = this.conns.get(peerId);
    const f = this.files.get(trackId);
    if (!c || !f) return;
    const CHUNK = 32 * 1024;
    for (const i of indexes.slice(0, 400)) {
      if (!c.conn.open) return;
      await this.waitForDrain(c.conn);
      this.send(c.conn, {
        type: 'TRACK_CHUNK', trackId, index: i,
        bytes: f.bytes.slice(i * CHUNK, Math.min((i + 1) * CHUNK, f.bytes.byteLength)),
      });
    }
  }

  /**
   * Send this phone every song it is missing, current one first, before it is
   * ever asked to play them. A speaker that already holds the bytes starts
   * instantly and does not care how slow its connection is.
   */
  private prefetch(peerId: string) {
    const order = [
      this.transport.playlist[this.transport.trackIndex],
      ...this.transport.playlist,
    ].filter(Boolean) as AudioTrack[];
    // the song that is playing jumps the queue; the rest fills in behind it
    order.forEach((t, i) => void this.enqueueTrack(peerId, t.id, { urgent: i === 0 }));
  }

  private async sendTrack(peerId: string, trackId?: string, force = false) {
    const c = this.conns.get(peerId);
    const cur = trackId
      ? this.transport.playlist.find((t) => t.id === trackId)
      : this.transport.playlist[this.transport.trackIndex];
    if (!c || !cur) return;
    const f = this.files.get(cur.id);
    if (!f) return;
    if (c.sent.has(cur.id) && !force) return;
    c.sent.add(cur.id);

    this.sending.set(peerId, cur.id);
    // 32 kB meant ~170 messages per megabyte, each one an await; 128 kB moves
    // the same bytes with a quarter of the overhead and still interleaves
    // commands quickly enough.
    const CHUNK = 32 * 1024;
    const total = Math.ceil(f.bytes.byteLength / CHUNK);
    this.send(c.conn, {
      type: 'TRACK_META', trackId: cur.id, title: cur.title, mime: f.mime,
      size: f.bytes.byteLength, chunks: total,
    });

    for (let i = 0; i < total; i++) {
      if (!this.conns.has(peerId) || !c.conn.open) { c.sent.delete(cur.id); this.sending.delete(peerId); return; }
      // somebody is waiting on a different song: drop this background
      // transfer and let the urgent one run
      const box = this.outbox.get(peerId);
      if (box?.urgent.length && box.urgent[0].trackId !== cur.id) {
        // somebody is waiting on a different song: drop this background
        // transfer, remember nothing was delivered, and let the urgent one run
        c.sent.delete(cur.id); this.sending.delete(peerId);
        void this.enqueueTrack(peerId, cur.id);   // finish it later
        return;
      }
      // Two things matter and they pull in opposite directions: a command
      // must never queue behind megabytes of audio, and the track still has
      // to arrive quickly. So the channel is kept almost empty for a moment
      // around a transport command, and allowed to run full the rest of the
      // time.
      // 48 kB in flight is still ~8 Mbit/s at a 50 ms round trip, so this
      // costs nothing in practice and it is what keeps a PAUSE from queueing
      // behind megabytes of audio. (Raising it measurably broke PAUSE.)
      // No sleep here any more. It used to stall EVERY chunk for 150 ms
      // whenever a command had just gone out, and with status traffic that
      // was most of the time — a 5 MB song then took five seconds to reach
      // one phone. Commands are protected by the shallow queue ceiling in
      // waitForDrain instead, which costs no throughput.
      await this.waitForDrain(c.conn);
      // hand the main thread back between chunks: the clock replies and the
      // audio callbacks live there too, and starving them is what turned a
      // transfer into audible drift
      if ((i & 7) === 7) await new Promise((r) => setTimeout(r, 0));
      this.send(c.conn, {
        type: 'TRACK_CHUNK', trackId: cur.id, index: i,
        bytes: f.bytes.slice(i * CHUNK, Math.min((i + 1) * CHUNK, f.bytes.byteLength)),
      });
    }
    if (this.sending.get(peerId) === cur.id) this.sending.delete(peerId);
    c.doneAt[cur.id] = Date.now();
  }

  /**
   * Back-pressure, the fast way.
   *
   * This used to poll `bufferedAmount` every 40 ms with a 48 kB ceiling. That
   * is a hard speed limit of about one megabyte per second no matter how good
   * the link is — a 5 MB song took five seconds to reach ONE phone, which is
   * why a phone that joined late, or a song that had just been switched, sat
   * there silent. The browser already fires an event the moment the queue
   * drains, so we use that, and we let a comfortable amount sit in flight.
   *
   * The ceiling drops back to a trickle for a moment around every transport
   * command, so a PAUSE still never queues behind megabytes of audio.
   */
  private waitForDrain(conn: DataConnection, limit?: number) {
    const dc: RTCDataChannel | undefined = (conn as any).dataChannel;
    if (!dc) return Promise.resolve();
    // just after a command: keep the pipe nearly empty so the command wins
    const quiet = Date.now() - this.lastCommandAt < 300;
    const ceiling = limit ?? (quiet ? 48 * 1024 : 128 * 1024);
    if (dc.bufferedAmount < ceiling) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        dc.removeEventListener('bufferedamountlow', finish);
        window.clearInterval(t);
        resolve();
      };
      dc.bufferedAmountLowThreshold = Math.floor(ceiling / 2);
      dc.addEventListener('bufferedamountlow', finish);
      // safety net: a closed channel fires nothing
      const t = window.setInterval(() => {
        if (!conn.open || dc.bufferedAmount < ceiling) finish();
      }, 50);
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

  /* ------------------------------ microphone ---------------------------- */

  private micStream: MediaStream | null = null;
  private micCalls = new Map<string, MediaConnection>();

  /**
   * Live microphone to every speaker.
   *
   * This is a normal WebRTC audio track (not the scheduled file timeline), so
   * it behaves like a PA system: lowest latency the network allows, roughly
   * 100–250 ms over the internet, and it is NOT sample-accurate across phones
   * the way a scheduled song is. Speak into the host, everyone hears it.
   */
  async toggleMic() {
    if (this.micStream) { this.stopMic(); return; }
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      this.set({ micOn: true, info: 'Microphone is live on every speaker. Keep phones apart to avoid feedback.' });
      this.conns.forEach((_c, peerId) => this.callPeer(peerId));
    } catch {
      this.set({ error: 'Could not open the microphone. Allow mic access for this site and try again.' });
    }
  }

  private callPeer(peerId: string) {
    if (!this.micStream || !this.peer) return;
    try {
      const call = this.peer.call(peerId, this.micStream);
      this.micCalls.get(peerId)?.close();
      this.micCalls.set(peerId, call);
      call.on('close', () => this.micCalls.delete(peerId));
    } catch { /* that phone will get the mic on its next reconnect */ }
  }

  stopMic() {
    this.micCalls.forEach((c) => { try { c.close(); } catch {} });
    this.micCalls.clear();
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    this.set({ micOn: false, info: null });
  }

  get micLive() { return !!this.micStream; }
  /** the live mic signal, for the host's own level meter */
  get micSource() { return this.micStream; }

  /* ------------------------- the host's own output ----------------------- */

  get localAudioOn() { return this.localWanted; }
  /** diagnostics: what this device's own output is doing right now */
  get localAudioState() {
    return this.local ? { t: this.local.currentTime, paused: this.local.paused } : null;
  }

  /**
   * Play on this phone as well, scheduled against the very same host clock the
   * speakers use — so the controller is just one more speaker in the room.
   * Browsers only allow this after a tap, which the toggle itself provides.
   */
  setLocalAudio(on: boolean) {
    this.localWanted = on;
    localStorage.setItem('sm.hostAudio', on ? '1' : '0');
    if (!on) { this.stopLocal(); } else { this.applyLocal(); }
    this.set({});
  }

  private stopLocal() {
    window.clearTimeout(this.localTimer);
    if (this.local) { try { this.local.pause(); } catch {} }
  }

  private localEl() {
    if (!this.local) {
      const a = new Audio();
      a.preload = 'auto';
      a.addEventListener('ended', () => { if (this.transport.autoNext) this.next(); });
      this.local = a;
    }
    return this.local;
  }

  /** Mirror the current transport onto this device's own audio element. */
  private applyLocal() {
    if (!this.localWanted) return;
    const cur = this.transport.playlist[this.transport.trackIndex];
    const a = this.localEl();
    a.volume = this.transport.volume;
    if (!cur) { this.stopLocal(); return; }
    if (a.dataset.id !== cur.id) { a.src = cur.url; a.dataset.id = cur.id; a.load(); }

    window.clearTimeout(this.localTimer);
    if (this.transport.state !== 'playing') {
      try { a.pause(); } catch {}
      a.currentTime = Math.max(0, this.transport.position);
      return;
    }
    const at = this.transport.positionAtServerTime;
    const startIn = at - Date.now();
    const begin = () => {
      // Same scheduling the speakers do: seek to where the timeline will be
      // at this instant, then start.
      const late = Math.max(0, Date.now() - at) / 1000;
      try { a.currentTime = Math.max(0, this.transport.position + late); } catch {}
      void a.play().catch(() => {
        this.set({ info: 'Tap PLAY once more to let this phone play sound too.' });
      });
    };
    if (startIn <= 12) begin();
    else this.localTimer = window.setTimeout(begin, startIn - 8);
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
    this.hintNext();
    this.conns.forEach((_c, p) => void this.enqueueTrack(p, undefined, { urgent: true }));
    this.lastCommandAt = Date.now();
    this.broadcastReliable({ type: 'PLAY', seq: ++this.cmdSeq, trackId: track.id, position: pos, startAt });
    this.applyLocal();
  }

  pause() {
    if (this.transport.state !== 'playing') return;
    const pos = this.livePosition();
    this.transport = { ...this.transport, state: 'paused', position: pos, positionAtServerTime: Date.now() };
    this.pushTransport();
    this.lastCommandAt = Date.now();
    this.broadcastReliable({ type: 'PAUSE', seq: ++this.cmdSeq, position: pos });
    this.applyLocal();
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  stop() {
    this.transport = { ...this.transport, state: 'stopped', position: 0, positionAtServerTime: Date.now() };
    this.pushTransport();
    this.lastCommandAt = Date.now();
    this.broadcastReliable({ type: 'STOP', seq: ++this.cmdSeq });
    this.applyLocal();
  }

  seek(position: number) {
    const track = this.track;
    if (!track) return;
    const applyAt = Date.now() + SYNC.APPLY_LEAD_MS;
    this.transport = { ...this.transport, position, positionAtServerTime: applyAt };
    this.pushTransport();
    this.lastCommandAt = Date.now();
    this.broadcastReliable({ type: 'SEEK', seq: ++this.cmdSeq, trackId: track.id, position, applyAt });
    this.applyLocal();
  }

  next() { this.skip(1); }
  prev() { this.skip(-1); }
  private skip(d: number) {
    const i = this.transport.trackIndex + d;
    if (i < 0 || i >= this.transport.playlist.length) { this.stop(); return; }
    this.play(this.transport.playlist[i].id, 0);
  }
  playTrack(id: string) { this.play(id, 0); }

  /* ------------------------------- YouTube ------------------------------ */

  /**
   * Hand every phone the same video and the same clock. We cannot send the
   * audio (see lib/audio/youtube.ts), so each phone plays its own stream at
   * the position we name.
   */
  youtube(videoId: string | null, position = 0, playing = true) {
    this.ytState = { videoId, position, atHostTime: Date.now() + 1200, playing };
    this.lastCommandAt = Date.now();
    this.broadcastReliable({ type: 'YT', seq: ++this.cmdSeq, ...this.ytState });
    this.set({ youtubeId: videoId, info: videoId ? null : this.state.info });
  }

  youtubePause(position: number) {
    if (!this.ytState.videoId) return;
    this.ytState = { ...this.ytState, position, atHostTime: Date.now(), playing: false };
    this.broadcastReliable({ type: 'YT', seq: ++this.cmdSeq, ...this.ytState });
  }

  /** Keep late joiners on the video too. */
  private ytState: { videoId: string | null; position: number; atHostTime: number; playing: boolean } =
    { videoId: null, position: 0, atHostTime: 0, playing: false };
  private sendYtTo(conn: DataConnection) {
    if (!this.ytState.videoId) return;
    this.send(conn, { type: 'YT', seq: ++this.cmdSeq, ...this.ytState });
  }

  volume(v: number) {
    this.transport = { ...this.transport, volume: v };
    this.pushTransport();
    this.lastCommandAt = Date.now();
    this.broadcastReliable({ type: 'VOLUME', seq: ++this.cmdSeq, volume: v });
    this.applyLocal();
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
    this.lastCommandAt = Date.now();
    this.broadcastReliable({ type: 'STOP', seq: ++this.cmdSeq });
    this.applyLocal();
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
