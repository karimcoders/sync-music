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
  /** tracks whose bytes this speaker already has */
  sent: Set<string>;
  /** last time we pushed a repair snapshot to this speaker */
  lastRepair: number;
  sending?: boolean;
  lastBias?: number;
  lastErr?: number;
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
      this.urgent.delete(peerId);
      this.clockReady.delete(peerId);
      this.latency.delete(peerId);
      this.publishSpeakers();
    });
  }

  private set(p: Partial<HostState>) { this.state = { ...this.state, ...p }; this.onChange(this.state); }
  private pushTransport() { this.set({ transport: { ...this.transport } }); }

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
      this.publishSpeakers();
    };
    conn.on('close', drop);
    conn.on('error', drop);
  }

  private onData(peerId: string, m: P2PMessage) {
    const c = this.conns.get(peerId);
    if (!c) return;
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
          this.urgent.delete(other);
          this.latency.delete(other);
          this.clockReady.delete(other);
        });
        if (m.name) { c.info = { ...c.info, name: m.name }; }
        this.publishSpeakers();
        // Everything this phone kept from an earlier session is a transfer we
        // do not have to make — that is what makes the next PLAY instant.
        (m.cached ?? []).forEach((id) => c.sent.add(id));
        this.prefetch(peerId);
        break;
      }
      case 'STATUS': {
        (m.cached ?? []).forEach((id) => c.sent.add(id));
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
      case 'TRACK_WANT': {
        // That phone is on the wrong song and cannot play anything until it
        // has this file. Jump the queue, and ignore our own bookkeeping that
        // says we already sent it — plainly it did not arrive, and silently
        // doing nothing left the phone stuck on "Switching to the new song".
        const c0 = this.conns.get(peerId);
        // Already on its way? Then restarting it would throw away everything
        // sent so far and make the phone wait longer, not less.
        if (this.sending.get(peerId) === m.trackId) break;
        if (c0) c0.sent.delete(m.trackId);
        this.urgent.set(peerId, m.trackId);
        void this.pushTrackTo(peerId, m.trackId, true);
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
  /**
   * Transfers are serialised. The host has ONE uplink: sending the same file to
   * three phones at once simply makes all three slower, and the saturated
   * channels then delay the PLAY/PAUSE messages — which is exactly what the
   * stuttering felt like.
   */
  private queue: Promise<void> = Promise.resolve();
  /**
   * The song a phone is waiting on RIGHT NOW. Prefetching the rest of the
   * playlist must never make somebody wait to hear the song that is actually
   * playing, so an in-flight background transfer is abandoned for this one
   * and picked up again afterwards.
   */
  private urgent = new Map<string, string>();
  /** the file currently streaming to each phone */
  private sending = new Map<string, string>();
  /** which physical phone is behind each peer connection */
  private deviceOf = new Map<string, string>();
  private pushTrackTo(peerId: string, trackId?: string, force = false) {
    const run = () => this.sendTrack(peerId, trackId, force);
    this.queue = this.queue.then(run, run);
    return this.queue;
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
    order.forEach((t) => void this.pushTrackTo(peerId, t.id));
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
      const want = this.urgent.get(peerId);
      if (want && want !== cur.id) { c.sent.delete(cur.id); this.sending.delete(peerId); return; }
      // Two things matter and they pull in opposite directions: a command
      // must never queue behind megabytes of audio, and the track still has
      // to arrive quickly. So the channel is kept almost empty for a moment
      // around a transport command, and allowed to run full the rest of the
      // time.
      // 48 kB in flight is still ~8 Mbit/s at a 50 ms round trip, so this
      // costs nothing in practice and it is what keeps a PAUSE from queueing
      // behind megabytes of audio. (Raising it measurably broke PAUSE.)
      const since = Date.now() - this.lastCommandAt;
      if (since < 300) await new Promise((r) => setTimeout(r, Math.max(0, 150 - since)));
      await this.waitForDrain(c.conn);
      this.send(c.conn, {
        type: 'TRACK_CHUNK', trackId: cur.id, index: i,
        bytes: f.bytes.slice(i * CHUNK, Math.min((i + 1) * CHUNK, f.bytes.byteLength)),
      });
    }
    if (this.sending.get(peerId) === cur.id) this.sending.delete(peerId);
    if (this.urgent.get(peerId) === cur.id) {
      this.urgent.delete(peerId);
      // the queue-jumped song is there; resume filling the rest of the playlist
      this.prefetch(peerId);
    }
  }

  /** Back-pressure: never let more than ~512 kB sit in the send queue. */
  private waitForDrain(conn: DataConnection, limit = 48 * 1024) {
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
    this.conns.forEach((_c, p) => void this.pushTrackTo(p));
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
