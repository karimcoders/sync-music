import Peer, { DataConnection } from 'peerjs';
import { getTrack, putTrack, trackIds } from './speakerCache';
import { fetchTrack } from './cloud';
import { WebAudioPlayer } from './bufferPlayer';
import { MixerChannel, loadSettings, saveSettings, type MixerSettings } from '../audio/mixer';
import { createPlayer, type YtHandle } from '../audio/youtube';

import { ClockSync, DriftController, projectPosition } from '@sync-music/sync-engine';
import { SILENT_WAV, type UiState } from '../client';
import { P2PMessage, peerOptions, ROOM_SLOTS, FIXED_ROOM_ID, BROKERS } from './messages';

/**
 * Direct-mode speaker.
 *
 * Identical playback discipline to the server mode — NTP-style offset
 * estimation, start times scheduled on the authority's clock, the same
 * ignore / rate-nudge / seek drift policy — except the authority is the host's
 * browser and the audio arrives over the data channel instead of from a CDN.
 */
export class P2PSpeakerClient {
  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private clock = new ClockSync();
  private drift = new DriftController();
  /**
   * Two possible outputs, and we always prefer the first:
   *
   *  - `wa`: the decoded Web Audio player. Starts at an exact instant, never
   *    re-buffers, corrects by ramping rate. This is what killed the stutter.
   *  - `el`: a plain <audio> element, kept as the fallback for a format the
   *    browser will not decode and for a track still arriving.
   *
   * `this.audio` hands back whichever is live, with the same small API.
   */
  private el: HTMLAudioElement | null = null;
  private wa: WebAudioPlayer | null = null;
  private ctx: AudioContext | null = null;
  private blob: Blob | null = null;
  /**
   * Every complete song this phone holds, kept in MEMORY. A switch to one of
   * these needs no IndexedDB read and no network at all, so it is instant.
   * (It used to go through an async IndexedDB lookup every single time, and a
   * song whose cache write had not finished yet was simply downloaded again.)
   */
  private mem = new Map<string, { title: string; blob: Blob }>();
  /** decoded PCM for at most two songs: the current one and the announced next one */
  private decodedBufs = new Map<string, AudioBuffer>();
  private decodeJobs = new Map<string, Promise<AudioBuffer | null>>();
  /** songs this browser could not decode (format / out of memory): use the element */
  private decodeFailed = new Set<string>();
  /** the song the host last talked about, and the one it said comes next */
  private hostTrack: string | null = null;
  private nextHint: string | null = null;
  private predecodeTimer = 0;
  private get audio(): any { return this.wa?.ready ? this.wa : this.el; }
  private audioEnabled = false;

  private transportPlaying = false;
  private basePosition = 0;
  private baseHostTime = 0;
  private trackId: string | null = null;      // track we are playing
  private haveTrack: string | null = null;    // track whose bytes we hold
  private objectUrl: string | null = null;
  /** last transport command applied — reported back so the host can repair us */
  private appliedSeq = 0;
  /** in-flight chunked download */
  private incoming: { trackId: string; title: string; mime: string; chunks: number; parts: (ArrayBuffer | undefined)[]; got: number } | null = null;
  private lastChunkAt = 0;
  private chaseTimer = 0;
  private timers: number[] = [];
  private playTimer: number | null = null;
  /** last clock offset we aligned playback against */
  private alignedOffset = 0;
  private closed = false;
  private retry = 0;
  private lastInbound = 0;
  /** a probe ping is outstanding on a quiet but still-open channel */
  private probed = false;
  private reconnectPending = false;

  state: UiState = {
    conn: 'disconnected', phase: 'DISCONNECTED', sessionId: null, sessionName: '', speakerName: '',
    hostOnline: false, trackTitle: '', trackArtist: '', position: 0, duration: 0, playing: false,
    muted: false, volume: 1, latencyMs: 0, driftMs: 0, clockSynced: false, bufferedPct: 0,
    error: null, info: null,
  };

  private listeners = new Set<(s: UiState) => void>();
  constructor(private roomId: string, onChange: (s: UiState) => void) { this.listeners.add(onChange); }
  /** Several screens can watch one running client (it must outlive any single page). */
  subscribe(fn: (s: UiState) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  get room() { return this.roomId; }

  /** diagnostics for tools/p2p-e2e.mjs */
  get debug() {
    return {
      offset: (this.clock as any).offset, rtt: (this.clock as any).rtt,
      synced: this.clock.synced, base: this.basePosition, baseAt: this.baseHostTime,
      target: this.targetPosition(), now: this.clock.now(),
    };
  }

  private set(p: Partial<UiState>) { this.state = { ...this.state, ...p }; this.listeners.forEach((fn) => fn(this.state)); }

  /** Same entry point the server-mode client exposes; there is nothing to list. */
  /**
   * The Speaker page calls this every few seconds while it has no session.
   * It used to call connect() each time, and connect() destroys the peers it
   * is in the middle of negotiating with — so on any link that needs more
   * than 4 s to set up (every relayed / mobile-data connection) the phone
   * restarted the attempt forever and never connected. Starting is now done
   * once; retries are the client's own business (scheduleReconnect).
   */
  async autoConnect() { if (!this.started) this.connect(); return []; }


  private peers: Peer[] = [];
  private started = false;
  private connectedAt = 0;
  private openBrokers = new Set<number>();
  private missing = new Map<number, Set<string>>();
  private dialsInFlight = 0;
  /** bumped on every fresh attempt; a stale attempt's timers must not act on a newer one */
  private round = 0;
  private diagMap = new Map<string, string>();
  /** timers that belong to ONE connection; they are cleared when it is replaced */
  private connTimers: number[] = [];
  private reportTimer = 0;

  private clearConnTimers() {
    this.connTimers.forEach((t) => { window.clearTimeout(t); window.clearInterval(t); });
    this.connTimers = [];
    window.clearTimeout(this.reportTimer);
  }

  /** One plain line of connection progress, shown on screen so it is never a mystery. */
  private note(key: string, text: string | null) {
    if (text === null) this.diagMap.delete(key); else this.diagMap.set(key, text);
    this.set({ diag: [...this.diagMap.values()] });
  }

  connect() {
    this.started = true;
    this.closed = false;
    this.clearConnTimers();
    this.openBrokers.clear();
    this.missing.clear();
    this.dialsInFlight = 0;
    this.round++;
    this.connectedAt = Date.now();
    this.diagMap.clear();
    this.note('net', navigator.onLine === false
      ? 'Internet: this phone reports it is OFFLINE'
      : 'Internet: online');
    // Do not shout over music that is playing perfectly well. A reconnect
    // while this phone is mid-song is housekeeping, not an outage: the
    // screenshot that started this said CONNECTING and "Looking for the
    // host…" directly above a song playing at 1 ms of drift, which is
    // alarming and untrue. Only a phone that is actually silent is
    // "connecting".
    const sounding = this.transportPlaying && !!this.audio && !this.audio.paused;
    this.set(sounding
      ? { conn: 'reconnecting', error: null, info: 'Playing from this phone — reconnecting quietly.' }
      : { conn: 'connecting', phase: 'CONNECTING', info: 'Looking for the host…', error: null });
    // Register on EVERY broker at once. The host may have had to fall back to
    // a different one (the public one rate-limits and holds stale ids), and a
    // phone should not spend half a minute discovering that one by one.
    this.peers.forEach((p) => { try { p.destroy(); } catch {} });
    this.peers = BROKERS.map((_, b) => {
      this.note(`b${b}`, `Broker ${b + 1}: connecting…`);
      const peer = new Peer(peerOptions(b));
      peer.on('open', () => {
        if (this.closed) return;
        this.openBrokers.add(b);
        this.note(`b${b}`, `Broker ${b + 1}: ready`);
        this.dial(peer, b);
      });
      // The host may open a live microphone; answer with no stream of our own.
      peer.on('call', (call) => {
        try { call.answer(); } catch { return; }
        call.on('stream', (stream: MediaStream) => this.playMic(stream));
        call.on('close', () => this.stopMic());
      });
      peer.on('error', (e: any) => {
        // One broker failing is not fatal while another may still answer, and
        // it must never disturb a connection we already have.
        if (this.conn?.open) return;
        if (e?.type === 'peer-unavailable') {
          this.onSlotMissing(b, /peer\s+(\S+)/.exec(String(e?.message ?? ''))?.[1] ?? '');
          return;
        }
        this.note(`b${b}`, `Broker ${b + 1}: ${e?.type ?? 'error'}${navigator.onLine === false ? ' (no internet)' : ''}`);
      });
      return peer;
    });
    this.peer = this.peers[0];
    // Nothing at all answered (every broker down / no internet): start over.
    this.connTimers.push(window.setTimeout(() => {
      if (this.closed || this.conn?.open || this.dialsInFlight > 0 || this.openBrokers.size > 0) return;
      this.set({ error: 'Could not reach the connection service. Check this phone’s internet, then it will keep trying.' });
      this.scheduleReconnect(500);
    }, 20000));
  }

  /**
   * "peer-unavailable" arrives once per EMPTY slot — three of the four slots
   * are always empty, and the old code treated each one as "the host is
   * offline" while the one real slot was still negotiating. Only conclude
   * "nobody is hosting" when every slot on every reachable broker is empty.
   */
  private onSlotMissing(b: number, slot: string) {
    const set = this.missing.get(b) ?? new Set<string>();
    if (slot) set.add(slot);
    this.missing.set(b, set);
    this.checkNotFound();
  }

  private checkNotFound() {
    if (this.closed || this.conn?.open) return;
    const need = this.roomId === FIXED_ROOM_ID ? ROOM_SLOTS.length : 1;
    const opened = [...this.openBrokers];
    if (!opened.length) return;
    const allEmpty = opened.every((b) => (this.missing.get(b)?.size ?? 0) >= need);
    if (!allEmpty) return;
    // a broker that has not opened yet could still be the one the host is on
    const waited = Date.now() - this.connectedAt;
    if (opened.length < BROKERS.length && waited < 8000) {
      this.connTimers.push(window.setTimeout(() => this.checkNotFound(), 8000 - waited));
      return;
    }
    this.note('host', 'Host: not found — nobody is hosting this room yet');
    this.set({
      conn: 'reconnecting', hostOnline: false,
      info: 'Host is not online right now — retrying…',
      error: this.retry >= 3 ? 'Nobody is hosting on this link right now. Ask them to open the host page and keep it open.' : null,
    });
    this.scheduleRedial();
  }

  /**
   * "Nobody is hosting yet": keep our broker registrations (re-registering
   * every second hammers the public broker and burns a new id each time) and
   * just knock on the room slots again, at a steady pace so a host that
   * starts a moment later is found within a couple of seconds.
   */
  private scheduleRedial() {
    if (this.closed || this.reconnectPending) return;
    this.reconnectPending = true;
    this.retry++;
    const wait = Math.min(3000, 1000 + 500 * this.retry);
    this.timers.push(window.setTimeout(() => {
      this.reconnectPending = false;
      if (this.closed || this.conn?.open) return;
      this.missing.clear();
      this.round++;
      this.peers.forEach((pr, b) => {
        if (!this.openBrokers.has(b)) return;
        try { this.dial(pr, b); } catch { /* that broker will be retried by the next full reconnect */ }
      });
    }, wait));
  }

  private scheduleReconnect(fixedWait?: number) {
    if (this.closed || this.reconnectPending) return;
    if (this.conn?.open) return;              // already have a live channel
    this.reconnectPending = true;
    this.retry++;
    const wait = fixedWait ?? Math.min(8000, 800 * 2 ** Math.min(this.retry, 4));
    this.timers.push(window.setTimeout(() => {
      this.reconnectPending = false;
      if (this.closed) return;
      try { this.peers.forEach((p) => p.destroy()); } catch {}
      this.connect();
    }, wait));
  }

  /**
   * The room is one shared link but a short list of broker slots (the public
   * broker can keep a name reserved after a host leaves). All slots are tried
   * at once; the first channel that opens wins and the rest are dropped.
   */
  private dial(peer: Peer, b: number) {
    const targets = this.roomId === FIXED_ROOM_ID ? ROOM_SLOTS : [this.roomId];
    const round = this.round;
    this.dialsInFlight++;
    let settled = false;
    const settle = () => { if (!settled) { settled = true; this.dialsInFlight--; } };
    this.note('host', `Host: looking on ${targets.length} room slot${targets.length > 1 ? 's' : ''}…`);
    const tried = targets.map((t) => peer.connect(t, { reliable: true }));
    let won: DataConnection | null = null;

    // A relayed WebRTC link on mobile data legitimately needs 10–20 s. The
    // old 5 s watchdog closed the channel in the middle of that negotiation and
    // started over, so a slow-but-working link never completed.
    const started = Date.now();
    const watchdog = window.setTimeout(() => {
      settle();
      if (won || this.conn?.open || round !== this.round) return;   // a newer attempt owns the state now
      this.note('link', 'Link: could not be opened in 25 s');
      this.set({
        error: 'Found the room but could not open a link. Both phones need internet and the '
          + 'host tab must stay open. On a restricted network, try the same Wi-Fi or a mobile hotspot.',
      });
      tried.forEach((c) => { try { c.close(); } catch {} });
      this.scheduleReconnect(300);
    }, 25000);
    this.connTimers.push(watchdog);

    const poll = window.setInterval(() => {
      if (won || settled || round !== this.round) { window.clearInterval(poll); return; }
      const st = tried.map((c) => (c as any).peerConnection?.iceConnectionState).find(Boolean);
      if (st) this.note('link', `Link: negotiating… ${Math.round((Date.now() - started) / 1000)} s (${st})`);
    }, 1000);
    this.connTimers.push(poll);

    tried.forEach((conn) => {
      conn.on('open', () => {
        if (won || this.state.conn === 'connected') { try { conn.close(); } catch {} return; }
        won = conn;
        settle();
        this.conn = conn;
        this.peer = peer;
        // drop the brokers we no longer need
        this.peers.forEach((p) => { if (p !== peer) { try { p.destroy(); } catch {} } });
        this.peers = [peer];
        window.clearTimeout(watchdog);
        window.clearInterval(poll);
        tried.forEach((o) => { if (o !== conn) { try { o.close(); } catch {} } });
        this.note('host', 'Host: found');
        this.note('link', 'Link: open');
        this.onConnected(conn);
      });
      conn.on('data', (d) => {
        if (won !== conn) return;
        this.lastInbound = Date.now();
        void this.handle(d as P2PMessage);
      });
      const lost = () => {
        if (won !== conn || this.conn !== conn) return;         // a dead slot, not our host
        this.clearConnTimers();
        this.set({
          conn: 'reconnecting', hostOnline: false,
          info: this.transportPlaying ? 'Playing from this phone — reconnecting quietly.' : null,
        });
        this.scheduleReconnect();
      };
      conn.on('close', lost);
      conn.on('error', lost);
    });
  }

  private onConnected(conn: DataConnection) {
    // everything that belonged to the previous connection stops here. These
    // timers used to pile up on every reconnect (duplicate pings, duplicate
    // STATUS reports, duplicate drift loops), which made a flaky link worse.
    this.clearConnTimers();
    this.retry = 0;
    this.reconnectPending = false;
    this.set({ conn: 'connected', sessionId: conn.peer, error: null, info: null,
      phase: this.audioEnabled ? 'AUDIO_READY' : 'AUDIO_DISABLED', hostOnline: true });
    void trackIds().then((cached) => {
      this.cachedIds = cached;
      this.send({ type: 'HELLO', deviceId: deviceId(), cached });
    });
    // A data channel is much jitterier than a WebSocket right after it opens,
    // and a bad offset here shows up directly as phones being apart. So we
    // probe hard for the first few seconds and keep a steady 1 Hz afterwards;
    // ClockSync keeps only the lowest-RTT third of the samples.
    for (let i = 0; i < 10; i++) this.connTimers.push(window.setTimeout(() => this.ping(), i * 150));
    this.connTimers.push(window.setInterval(() => this.ping(), 1000));
    this.lastInbound = Date.now();
    // The transport can also tell us the moment it really dies, which is far
    // faster and far more reliable than counting quiet seconds.
    const pc: RTCPeerConnection | undefined = (conn as any).peerConnection;
    if (pc) {
      const onState = () => {
        if (this.conn !== conn || this.closed) return;
        const st = pc.connectionState ?? pc.iceConnectionState;
        this.note('link', `Link: ${st}`);
        if (st === 'failed' || st === 'closed') {
          this.set({
            conn: 'reconnecting', hostOnline: false,
            info: this.transportPlaying ? 'Playing from this phone — reconnecting quietly.' : 'Lost the host — reconnecting…',
          });
          try { conn.close(); } catch {}
          this.clearConnTimers();
          this.scheduleReconnect(300);
        }
      };
      pc.addEventListener('connectionstatechange', onState);
      pc.addEventListener('iceconnectionstatechange', onState);
    }
    // PeerJS does not always fire 'close' when the host tab goes away (a
    // refresh, a crash, a dead Wi-Fi link). The host answers every PING, so
    // silence longer than a few seconds means the channel is gone.
    this.connTimers.push(window.setInterval(() => {
      if (this.closed || this.reconnectPending) return;
      const silent = Date.now() - this.lastInbound;
      if (silent < 6000) { this.probed = false; return; }
      // Six seconds of quiet does NOT mean the channel is dead. A host tab
      // that the phone's browser has throttled, a moment of packet loss on
      // mobile data, a screen that just went off — all of these produce a
      // gap, and tearing down a WORKING channel for them is what put a phone
      // in a permanent "Looking for the host…" loop while the song played on.
      // So: knock first, and only give up if nothing comes back.
      if (this.conn?.open && !this.probed) {
        this.probed = true;
        this.ping();
        return;                       // one more cycle to answer
      }
      // App-level silence is a GUESS. The transport layer knows the truth:
      // if the RTCPeerConnection is still 'connected', the link is physically
      // up and the quiet is the other phone being throttled (screen off,
      // background tab) — not a dead channel. Tearing that down was worse
      // than useless: the host tab is throttled too, so the fresh dial finds
      // nothing and the phone sits on RECONNECTING forever while the song
      // plays on. Never kill a link the transport says is alive.
      if (this.conn?.open && this.iceAlive()) {
        if (silent > 14000) this.note('link', 'Link: open but quiet — the host phone is asleep or throttled');
        return;
      }
      if (this.conn?.open && silent < 14000) return;   // still open: keep waiting
      this.probed = false;
      this.set({
        conn: 'reconnecting', hostOnline: false,
        info: this.transportPlaying
          ? 'Playing from this phone — reconnecting quietly.'
          : 'Lost the host — reconnecting…',
      });
      try { this.conn?.close(); } catch {}
      this.clearConnTimers();
      this.scheduleReconnect();
    }, 2000));
    this.startReporting();
  }

  /**
   * A dropped chunk used to mean the file never completed and that phone stayed
   * silent for the whole song. Now we notice the gap and ask for exactly the
   * missing pieces again.
   */
  /**
   * Is this phone holding the song the host is talking about?
   *
   * Every transport message names its track. Ignoring that name was a real
   * bug: a phone that had not received the new song simply carried on with
   * the old one at the new position, so two phones played two different
   * songs. Now a mismatch stops the music at once — silence is correct, the
   * wrong song is not — and we fetch the right one, from this phone's cache
   * if it is there (instant) or from the host if it is not.
   */
  private wantedTrack: string | null = null;
  private ensureTrack(trackId: string | null | undefined): boolean {
    if (!trackId) return true;
    this.hostTrack = trackId;
    if (trackId === this.trackId) return true;
    if (this.wantedTrack === trackId) return false;   // already fetching

    // The host changed song: whatever is playing stops NOW.
    try { this.el?.pause(); } catch {}
    this.wa?.clear();
    this.decodedId = null;
    this.trackId = null;

    // 1) Already in memory (the host prefetched it): switch with zero I/O.
    const held = this.mem.get(trackId);
    if (held) {
      this.wantedTrack = null;
      this.adoptTrack(trackId, held.title, held.blob, true, false);
      return true;
    }

    this.wantedTrack = trackId;
    this.set({ phase: 'SYNCING', info: 'Switching to the new song…', bufferedPct: 0 });

    // 2) Only open IndexedDB if it really holds this song; otherwise ask the
    //    host immediately instead of spending a lookup first.
    this.streamingId = null;
    const cloud = this.cloudInfo.get(trackId);
    if (cloud) {
      // The song is in the cloud: start playing it from there NOW, and let the
      // full copy download behind it. Do not also ask the host to push it.
      if (this.audioEnabled && this.startStreaming(trackId, cloud.title, cloud.url)) {
        void this.pullFromCloud(trackId, cloud.title, cloud.mime, cloud.url);   // the full copy, behind it
        return true;
      }
      void this.pullFromCloud(trackId, cloud.title, cloud.mime, cloud.url);
      return false;
    }
    if (!this.cachedIds.includes(trackId)) { this.askForTrack(trackId); return false; }
    void getTrack(trackId)
      .then((hit) => {
        if (this.wantedTrack !== trackId) return;     // the host moved on again
        if (hit) { this.adoptTrack(trackId, hit.title, new Blob([hit.bytes], { type: hit.mimeType })); return; }
        this.askForTrack(trackId);
      })
      .catch(() => this.askForTrack(trackId));
    return false;
  }

  /**
   * Should an arriving file become the song this phone is playing?
   *
   * The host sends the WHOLE playlist ahead of time so a switch is instant.
   * That prefetch used to hijack playback: the last file to arrive became
   * "the track", so the phone showed one song, held another's bytes, and a
   * later PLAY for that id looked like a match and played the wrong audio.
   * A file only becomes current if it is the one we were told to play.
   */
  private shouldBeCurrent(trackId: string) {
    if (this.wantedTrack) return this.wantedTrack === trackId;
    // The host names the current song in every transport message. "First
    // file to arrive wins" let phones end up on different songs, because
    // during the prefetch files land in whatever order the network gives.
    if (this.hostTrack) return this.hostTrack === trackId;
    if (this.trackId) return this.trackId === trackId;
    return true;                       // nothing named yet: be ready the instant PLAY comes
  }

  /**
   * Ask, and keep asking.
   *
   * One request is not enough: it can be lost while the channel is draining
   * megabytes, or the host may wrongly believe we already hold the file. A
   * phone that stops asking sits on "Switching to the new song" forever —
   * which is exactly what happened on a real phone.
   */
  private wantTimer = 0;
  private askForTrack(trackId: string) {
    // it is already arriving — asking again only restarts it
    if (this.incoming?.trackId !== trackId) this.send({ type: 'TRACK_WANT', trackId });
    window.clearInterval(this.wantTimer);
    this.wantTimer = window.setInterval(() => {
      if (this.wantedTrack !== trackId) { window.clearInterval(this.wantTimer); return; }
      if (this.incoming?.trackId === trackId) return;   // it is arriving, be patient
      this.send({ type: 'TRACK_WANT', trackId });
    }, 2500);
    this.timers.push(this.wantTimer);
  }

  /* ------------------------------ cloud copy ----------------------------- */

  /** where each song can be fetched from (sent by the host as TRACK_URL) */
  private cloudInfo = new Map<string, { title: string; mime: string; url: string }>();
  private cloudPulls = new Set<string>();
  /** the song the <audio> element is streaming straight from a URL right now */
  private streamingId: string | null = null;

  /**
   * Start the song NOW, from the URL, without waiting for the download. An
   * <audio> element given a URL streams it with HTTP range requests, so sound
   * starts after about a second; the full copy downloads quietly behind it and
   * the decoded, sample-accurate engine takes over when it lands.
   */
  private startStreaming(trackId: string, title: string, url: string): boolean {
    const el = this.el;
    if (!el || !this.audioEnabled) return false;
    try {
      this.wa?.clear();
      this.decodedId = null;
      this.trackId = trackId;
      this.streamingId = trackId;
      if (this.wantedTrack === trackId) this.wantedTrack = null;
      // Another origin: without CORS the element is "tainted" and Web Audio
      // outputs silence through it. The file host sends access-control-allow-origin: *.
      el.crossOrigin = 'anonymous';
      el.src = url;
      el.dataset.audioId = trackId;
      el.load();
      this.wa?.attachElement(el);
      this.applyVolume();
      this.set({ trackTitle: title, info: 'Playing while it downloads…', phase: 'SYNCING', bufferedPct: 0 });
      return true;
    } catch {
      this.streamingId = null;
      return false;
    }
  }

  private async pullFromCloud(trackId: string, title: string, mime: string, url: string) {
    if (this.cloudPulls.has(trackId)) return;
    if (this.mem.has(trackId)) { this.send({ type: 'TRACK_READY', trackId }); return; }
    this.cloudPulls.add(trackId);
    const current = () => this.wantedTrack === trackId || this.hostTrack === trackId;
    // sound first, if this is the song we are meant to be playing
    if (current() && this.streamingId !== trackId && this.trackId !== trackId) this.startStreaming(trackId, title, url);
    try {
      const bytes = await fetchTrack(url, (pct) => {
        if (!current()) return;
        this.set({
          info: this.streamingId === trackId ? `Playing while it downloads… ${pct}%` : `Getting the song… ${pct}%`,
          bufferedPct: pct,
        });
      });
      void putTrack({
        id: trackId, title, artist: '', filename: title, mimeType: mime || 'audio/mpeg',
        size: bytes.byteLength, duration: 0, bytes,
      }).then(() => { if (!this.cachedIds.includes(trackId)) this.cachedIds.push(trackId); }).catch(() => {});
      // the full copy is here: adopt it (this also tells the host)
      this.adoptTrack(trackId, title, new Blob([bytes], { type: mime || 'audio/mpeg' }), this.shouldBeCurrent(trackId) || this.streamingId === trackId);
    } catch {
      // the phone-to-phone transfer is still running underneath; say nothing alarming
      if (this.streamingId === trackId && !this.mem.has(trackId)) this.set({ info: 'Playing while it downloads…' });
    } finally {
      this.cloudPulls.delete(trackId);
    }
  }

  /** Keep a complete song in memory (small LRU; the live + announced songs are never evicted). */
  private remember(id: string, title: string, blob: Blob) {
    this.mem.delete(id);
    this.mem.set(id, { title, blob });
    for (const k of this.mem.keys()) {
      if (this.mem.size <= 16) break;
      if (k !== this.trackId && k !== this.nextHint && k !== this.hostTrack) this.mem.delete(k);
    }
  }

  /**
   * Point playback at a complete track, wherever the bytes came from.
   * `catchUp` is false when the caller is about to schedule playback itself.
   */
  private adoptTrack(trackId: string, title: string, blob: Blob, current = true, catchUp = true) {
    this.remember(trackId, title, blob);
    if (!current) {
      // keep it for later; do not touch what is playing
      this.send({ type: 'TRACK_READY', trackId });
      this.schedulePredecode();
      return;
    }
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(blob);
    this.blob = blob;
    this.trackId = trackId;
    this.haveTrack = trackId;
    if (this.wantedTrack === trackId) this.wantedTrack = null;
    // Drop the decoded buffer only when the song really changed. Re-decoding
    // the same file costs a second of CPU on a phone, and doing it at the
    // moment playback starts is exactly when that hurts.
    if (this.decodedId && this.decodedId !== trackId) { this.wa?.clear(); this.decodedId = null; }
    this.set({ trackTitle: title, trackArtist: '', info: null, bufferedPct: 100 });
    if (this.audioEnabled) this.loadAudio();
    this.send({ type: 'TRACK_READY', trackId });
    // we may have been told to play while the file was still arriving
    if (catchUp && this.transportPlaying) this.catchUp();
    this.schedulePredecode();
  }

  /* ------------------------------ YouTube ------------------------------- */

  private yt: YtHandle | null = null;
  private ytId: string | null = null;
  private ytTimer = 0;

  /**
   * Put this phone on the same video, at the same second.
   *
   * The audio cannot travel over our link, so what we synchronise is the
   * position. YouTube's own player is the thing making sound here, and its
   * seek is coarse, so we only correct when it is clearly out — chasing it
   * harder would make it stutter for no gain.
   */
  private async applyYouTube(videoId: string | null, position: number, atHostTime: number, playing: boolean) {
    if (!videoId) {
      this.yt?.pause();
      this.ytId = null;                 // so the same video can be started again later
      window.clearInterval(this.ytTimer);
      this.set({ youtubeId: null, info: null });
      return;
    }
    this.set({ youtubeId: videoId, trackTitle: 'YouTube', info: 'Loading the video on this phone…' });

    // the music file and the video must never play at once
    try { this.el?.pause(); } catch {}
    this.wa?.pause();

    const host = document.getElementById('yt-host');
    if (!host) { this.set({ info: 'This page has no room for the video player.' }); return; }

    if (!this.yt || this.ytId !== videoId) {
      try {
        if (!this.yt) {
          this.yt = await createPlayer(host, videoId, (msg) => this.set({ error: msg, info: null }));
        } else {
          this.yt.load(videoId, 0);
        }
        this.ytId = videoId;
      } catch {
        this.set({ error: 'YouTube could not be loaded on this phone.', info: null });
        return;
      }
    }

    this.yt.setVolume(this.state.muted ? 0 : this.state.volume);
    const at = () => (atHostTime - this.clock.now()) / 1000;
    const target = () => position + Math.max(0, -at());

    if (!playing) {
      this.yt.seekTo(position);
      this.yt.pause();
      this.set({ playing: false, info: null });
      return;
    }

    const lead = at();
    if (lead > 0.05) {
      this.yt.seekTo(position);
      window.setTimeout(() => { this.yt?.play(); }, Math.max(0, lead * 1000 - 120));
    } else {
      this.yt.seekTo(target());
      this.yt.play();
    }
    this.set({ playing: true, info: null, phase: 'PLAYING' });

    // Android may still refuse to start a video without a fresh tap. Say so
    // plainly and start on the next touch rather than sitting there silent.
    window.setTimeout(() => {
      if (!this.yt || this.yt.isPlaying()) return;
      this.set({ info: 'Tap the screen once to let the video play on this phone.' });
      const retry = () => {
        this.yt?.play();
        document.removeEventListener('pointerdown', retry);
        this.set({ info: null });
      };
      document.addEventListener('pointerdown', retry);
    }, 2500);

    // keep it there; YouTube drifts and sometimes pauses itself
    window.clearInterval(this.ytTimer);
    this.ytTimer = window.setInterval(() => {
      const p = this.yt;
      if (!p || !this.state.youtubeId) return;
      const want = position + (this.clock.now() - atHostTime) / 1000;
      const err = p.position() - want;
      if (!p.isPlaying()) { p.play(); return; }
      // 400 ms: below this a YouTube seek costs more than the error
      if (Math.abs(err) > 0.4) p.seekTo(want + 0.25);
      this.set({ position: p.position(), driftMs: Math.round(err * 1000) });
    }, 2000);
    this.timers.push(this.ytTimer);
  }

  /* ------------------------------- mixer -------------------------------- */

  /**
   * Two independent channel strips, exactly like a desk: the music and the
   * host's voice are mixed separately, because what makes a voice clear
   * (cut bass, lift mid) is the opposite of what makes music full.
   */
  private voiceMixer: MixerChannel | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;

  get mixers() {
    return {
      music: this.wa?.mixer ?? null,
      voice: this.voiceMixer,
    };
  }

  /** Change one strip live and remember it on this phone. */
  setMix(channel: 'music' | 'voice', next: Partial<MixerSettings>) {
    const ch = channel === 'music' ? this.wa?.mixer : this.voiceMixer;
    if (ch) {
      ch.apply(next);
      saveSettings(channel, ch.values);
    } else {
      // the strip does not exist yet (audio not enabled): remember anyway
      saveSettings(channel, { ...loadSettings(channel), ...next } as MixerSettings);
    }
    this.set({});
  }

  mixOf(channel: 'music' | 'voice'): MixerSettings {
    const ch = channel === 'music' ? this.wa?.mixer : this.voiceMixer;
    return ch ? ch.values : loadSettings(channel);
  }

  /** Play the host's live microphone alongside the music. */
  private micAudio: HTMLAudioElement | null = null;

  private ensureMicEl(): HTMLAudioElement {
    if (!this.micAudio) {
      const a = new Audio();
      (a as any).playsInline = true;
      a.autoplay = true;
      this.micAudio = a;
    }
    return this.micAudio;
  }

  private tapToPlay(el: HTMLAudioElement, what: string) {
    this.set({ info: `Tap the screen once to let ${what} through.` });
    const retry = () => {
      void el.play().then(() => this.set({ info: 'The host is speaking live.' })).catch(() => {});
      document.removeEventListener('pointerdown', retry);
    };
    document.addEventListener('pointerdown', retry);
  }

  private playMic(stream: MediaStream) {
    // The element is created and attached FIRST, in every case. The mixer
    // change used to attach the stream to Web Audio only, when no element
    // existed yet — and Chrome delivers a remote WebRTC stream into Web Audio
    // only while a media element is also playing it. Result: the host spoke
    // and the phones stayed silent.
    const el = this.ensureMicEl();
    el.srcObject = stream;
    if (this.ctx) {
      try {
        if (this.ctx.state === 'suspended') void this.ctx.resume();
        if (!this.voiceMixer) {
          this.voiceMixer = new MixerChannel(this.ctx);
          this.voiceMixer.apply(loadSettings('voice'));
        }
        this.voiceMixer.setMaster(this.state.muted ? 0 : this.state.volume);
        try { this.micSource?.disconnect(); } catch {}
        this.micSource = this.ctx.createMediaStreamSource(stream);
        this.micSource.connect(this.voiceMixer.input);
        el.muted = true;                       // the sound comes out through the mixer, not here
        void el.play().catch(() => this.tapToPlay(el, 'the host’s microphone'));
        this.set({ info: 'The host is speaking live.', hostMic: true });
        return;
      } catch { /* fall through to the plain element */ }
    }
    this.playMicPlain(stream);
  }

  private playMicPlain(stream: MediaStream) {
    const el = this.ensureMicEl();
    el.srcObject = stream;
    el.muted = false;
    el.volume = this.state.muted ? 0 : (this.state.volume ?? 1);
    void el.play().catch(() => this.tapToPlay(el, 'the host’s microphone'));
    this.set({ info: 'The host is speaking live.', hostMic: true });
  }

  private stopMic() {
    try { this.micSource?.disconnect(); } catch {}
    this.micSource = null;
    if (!this.micAudio) return;
    try { this.micAudio.pause(); } catch {}
    this.micAudio.srcObject = null;
    this.set({ info: null, hostMic: false });
  }

  /** how many chase rounds have produced no new pieces at all */
  private chaseStalled = 0;
  private chaseSeen = -1;

  private startChunkChase() {
    window.clearInterval(this.chaseTimer);
    this.chaseStalled = 0;
    this.chaseSeen = -1;
    this.chaseTimer = window.setInterval(() => {
      const inc = this.incoming;
      if (!inc) { window.clearInterval(this.chaseTimer); return; }
      if (Date.now() - this.lastChunkAt < 800) return;
      const missing: number[] = [];
      for (let i = 0; i < inc.chunks && missing.length < 400; i++) if (!inc.parts[i]) missing.push(i);
      if (!missing.length) return;

      // Is this actually getting anywhere? A phone that asks for 131 pieces,
      // then 150, then 150 again is not recovering — it is shouting into a
      // channel that is not answering (a host on a different build, a sender
      // that moved on, a transfer that died mid-way). Asking the same
      // question faster does not help, so after a few fruitless rounds we
      // stop and get the song a different way.
      if (inc.got === this.chaseSeen) this.chaseStalled++;
      else { this.chaseStalled = 0; this.chaseSeen = inc.got; }

      if (this.chaseStalled >= 4) {
        window.clearInterval(this.chaseTimer);
        const trackId = inc.trackId;
        this.incoming = null;
        const cloud = this.cloudInfo.get(trackId);
        if (cloud) {
          this.set({ info: 'That transfer stalled — downloading the song directly instead.' });
          void this.pullFromCloud(trackId, cloud.title, cloud.mime, cloud.url);
        } else {
          this.set({ info: 'That transfer stalled — asking the host to send the song again.' });
          this.askForTrack(trackId);
        }
        return;
      }

      this.lastChunkAt = Date.now();
      this.set({ info: `Re-requesting ${missing.length} missing piece(s) of the track…` });
      this.send({ type: 'TRACK_NEED', trackId: inc.trackId, indexes: missing });
    }, 400);
    this.timers.push(this.chaseTimer);
  }


  /**
   * True while the browser's own WebRTC stack still considers the link up.
   * Unknown (older WebViews that do not expose it) counts as alive: guessing
   * "dead" is what caused the permanent reconnect loop.
   */
  private iceAlive(): boolean {
    const pc: RTCPeerConnection | undefined = (this.conn as any)?.peerConnection;
    const st = pc?.connectionState ?? pc?.iceConnectionState;
    if (!st) return true;
    return st === 'connected' || st === 'completed' || st === 'new' || st === 'checking';
  }

  private send(m: P2PMessage) { try { if (this.conn?.open) this.conn.send(m); } catch {} }
  private ping() { this.send({ type: 'PING', t1: Date.now() }); }

  /* ------------------------------- events ------------------------------ */

  private async handle(m: P2PMessage) {
    // The host sends every transport command three times so a weak link
    // cannot swallow it. Applying the same one twice would re-schedule
    // playback, so anything we have already acted on is dropped here.
    if ('seq' in m && typeof (m as any).seq === 'number' && m.type !== 'STATE'
        && (m as any).seq <= this.appliedSeq) return;
    switch (m.type) {
      case 'WELCOME':
        this.set({ speakerName: m.name, sessionName: m.sessionName, hostOnline: true });
        break;

      case 'PONG': {
        const t4 = Date.now();
        this.clock.addSample(m.t1, m.t2, m.t3, t4);
        // A data channel's first seconds are very jittery: the offset estimate
        // can be hundreds of ms out, and anything we started during that window
        // began at the wrong moment. When the estimate materially improves,
        // realign playback once instead of waiting for the slow drift loop.
        if (Math.abs(this.clock.offset - this.alignedOffset) > 30) {
          this.alignedOffset = this.clock.offset;
          this.realign();
        }
        this.set({ latencyMs: Math.round(this.clock.latencyMs), clockSynced: this.clock.synced });
        break;
      }

      case 'PING':
        // the host measures us too
        this.send({ type: 'PONG', t1: m.t1, t2: Date.now(), t3: Date.now() });
        break;

      case 'TRACK_META': {
        // already playing exactly these bytes — never swap the blob under us
        if (this.trackId === m.trackId && this.objectUrl) {
          this.send({ type: 'TRACK_READY', trackId: m.trackId });
          break;
        }
        // Held in memory (e.g. prefetched earlier, or we switched away from it
        // and the host re-sent it): adopt it right now. THIS was the "stuck on
        // Switching to the new song…" bug: the old code answered TRACK_READY
        // and did nothing else, so a wanted song we already held never became
        // the current one and the phone waited forever.
        const held = this.mem.get(m.trackId);
        if (held) {
          this.adoptTrack(m.trackId, held.title, held.blob, this.shouldBeCurrent(m.trackId));
          break;
        }
        // Register the incoming transfer BEFORE any await. The host streams
        // chunks right behind this message; the old code awaited an
        // IndexedDB lookup first, so the first chunks arrived with nowhere to
        // go and were thrown away — every song then waited 2.5+ s for the
        // "re-request missing pieces" timer. That was a large part of why a
        // song change never felt instant.
        this.incoming = {
          trackId: m.trackId, title: m.title, mime: m.mime, chunks: m.chunks,
          parts: new Array(m.chunks), got: 0,
        };
        if (this.shouldBeCurrent(m.trackId)) {
          this.set({ trackTitle: m.title, info: m.chunks > 8 ? 'Receiving the new song…' : null, bufferedPct: 0 });
        }
        this.lastChunkAt = Date.now();
        this.startChunkChase();
        // Saved on an earlier night? Look, but never block the transfer on it.
        if (this.cachedIds.includes(m.trackId)) {
          const cached = await getTrack(m.trackId);
          if (cached && this.incoming?.trackId === m.trackId) {
            window.clearInterval(this.chaseTimer);
            this.incoming = null;
            this.adoptTrack(m.trackId, cached.title, new Blob([cached.bytes], { type: cached.mimeType }),
                            this.shouldBeCurrent(m.trackId));
          }
        }
        break;
      }

      case 'TRACK_CHUNK': {
        const inc = this.incoming;
        if (!inc || inc.trackId !== m.trackId || inc.parts[m.index]) break;
        inc.parts[m.index] = m.bytes;
        inc.got++;
        this.lastChunkAt = Date.now();
        const pct = Math.round((inc.got / inc.chunks) * 100);
        // Show the song arriving. A frozen "Switching…" looks broken even
        // when the transfer is healthy.
        this.set({
          bufferedPct: pct,
          info: this.wantedTrack === inc.trackId || this.trackId === null
            ? `Getting the new song… ${pct}%` : this.state.info,
        });
        if (inc.got < inc.chunks) break;

        const blob = new Blob(inc.parts as ArrayBuffer[], { type: inc.mime || 'audio/mpeg' });
        window.clearInterval(this.chaseTimer);
        this.incoming = null;
        // keep it: this phone never needs to download this song again, even
        // after a refresh or a night offline
        void blob.arrayBuffer().then((bytes) => {
          void putTrack({
            id: inc.trackId, title: inc.title, artist: '', filename: inc.title,
            mimeType: inc.mime || 'audio/mpeg', size: bytes.byteLength, duration: 0, bytes,
          });
          if (!this.cachedIds.includes(inc.trackId)) this.cachedIds.push(inc.trackId);
        });
        this.adoptTrack(inc.trackId, inc.title, blob, this.shouldBeCurrent(inc.trackId));
        break;
      }

      case 'CLOCK_BIAS':
        // Deliberately ignored: see the note in p2pHost.ts. Kept in the wire
        // format so an older host cannot break a newer speaker.
        break;

      case 'STATE': {
        // full repair snapshot from the host
        this.appliedSeq = Math.max(this.appliedSeq, m.seq);
        const switched = !this.ensureTrack(m.trackId);
        this.transportPlaying = m.playing;
        this.basePosition = m.position;
        this.baseHostTime = m.atHostTime;
        this.set({ playing: m.playing, volume: m.volume, trackTitle: m.title || this.state.trackTitle });
        this.applyVolume();
        if (!this.audioEnabled || switched) break;
        if (m.playing) this.catchUp();
        else { this.audio?.pause(); try { if (this.audio) this.audio.currentTime = m.position; } catch {} }
        break;
      }

      case 'PLAY':
        this.appliedSeq = Math.max(this.appliedSeq, m.seq);
        this.transportPlaying = true;
        this.basePosition = m.position;
        this.baseHostTime = m.startAt;
        this.hostTrack = m.trackId;
        // a song replaces a video: leaving the video running put two different sounds on one phone
        if (this.state.youtubeId) void this.applyYouTube(null, 0, 0, false);
        this.set({ playing: true });
        if (!this.audioEnabled) { this.set({ phase: 'AUDIO_DISABLED' }); break; }
        if (!this.ensureTrack(m.trackId)) break;   // wrong song: stay silent until we have the right one
        this.loadAudio();
        this.schedulePlay(m.position, m.startAt);
        break;

      case 'PAUSE': {
        this.appliedSeq = Math.max(this.appliedSeq, m.seq);
        this.transportPlaying = false;
        this.basePosition = m.position;
        this.baseHostTime = this.clock.now();
        if (this.playTimer) window.clearTimeout(this.playTimer);
        const a = this.audio;
        if (a) { a.pause(); try { a.currentTime = m.position; } catch {} }
        this.set({ playing: false, phase: this.audioEnabled ? 'AUDIO_READY' : 'AUDIO_DISABLED' });
        break;
      }

      case 'STOP':
        this.appliedSeq = Math.max(this.appliedSeq, m.seq);
        this.transportPlaying = false;
        this.basePosition = 0;
        if (this.playTimer) window.clearTimeout(this.playTimer);
        if (this.audio) { this.audio.pause(); try { this.audio.currentTime = 0; } catch {} }
        this.set({ playing: false, position: 0, phase: this.audioEnabled ? 'AUDIO_READY' : 'AUDIO_DISABLED' });
        break;

      case 'SEEK': {
        this.appliedSeq = Math.max(this.appliedSeq, m.seq);
        if (!this.ensureTrack(m.trackId)) break;
        this.basePosition = m.position;
        this.baseHostTime = m.applyAt;
        const wait = Math.max(0, m.applyAt - this.clock.now());
        window.setTimeout(() => {
          const a = this.audio;
          if (!a) return;
          try { a.currentTime = m.position; } catch {}
          if (this.transportPlaying) void a.play().catch(() => this.set({ phase: 'AUDIO_DISABLED' }));
        }, wait);
        break;
      }

      case 'RESYNC':
        this.appliedSeq = Math.max(this.appliedSeq, m.seq);
        this.transportPlaying = m.playing;
        this.basePosition = m.position;
        this.baseHostTime = m.atHostTime;
        this.drift.reset();
        this.set({ playing: m.playing });
        if (!this.ensureTrack(m.trackId)) break;
        if (this.audioEnabled) this.catchUp();
        break;

      case 'VOLUME':
        this.appliedSeq = Math.max(this.appliedSeq, m.seq);
        this.set({ volume: m.volume });
        this.applyVolume();
        break;

      case 'YT':
        this.appliedSeq = Math.max(this.appliedSeq, m.seq);
        void this.applyYouTube(m.videoId, m.position, m.atHostTime, m.playing);
        break;

      case 'RENAME':
        this.set({ speakerName: m.name });
        break;

      case 'MIX':
        // The host is the sound engineer: its strip wins on every phone.
        // setMix persists it too, so a phone that reloads keeps the room's sound.
        this.setMix(m.channel, m.settings as Partial<MixerSettings>);
        break;

      case 'BUILD':
        // The host and this phone run different builds of the app. Different
        // builds can disagree about the protocol, which shows up as phones that
        // behave differently from each other. Say so instead of hiding it.
        this.set({ hostBuild: m.build !== __BUILD__ ? m.build : null });
        break;

      case 'TRACK_URL':
        this.cloudInfo.set(m.trackId, { title: m.title, mime: m.mime, url: m.url });
        // Download in the background right away (prefetch), but only start
        // PLAYING it if it is the song the host is on.
        void this.pullFromCloud(m.trackId, m.title, m.mime, m.url);
        break;

      case 'NEXT_HINT':
        this.nextHint = m.trackId;
        this.trimDecoded();            // free the song we have moved past
        this.schedulePredecode();
        break;
    }
  }

  /* ------------------------------- audio -------------------------------- */

  async enableSpeaker(): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    if (!this.el) {
      const a = new Audio();
      a.preload = 'auto';
      (a as any).playsInline = true;
      a.addEventListener('loadedmetadata', () => this.set({ duration: a.duration || 0 }));
      a.addEventListener('progress', () => this.updateBuffered());
      this.el = a;
      // Diagnostics / e2e only: a live view of whichever output is actually
      // playing, so tools do not have to know which path we took.
      (window as any).__syncAudio = {
        get currentTime() { return self.audio?.currentTime ?? 0; },
        get paused() { return self.audio ? self.audio.paused : true; },
        get playbackRate() { return self.audio?.playbackRate ?? 1; },
        get duration() { return self.audio?.duration ?? 0; },
        get engine() { return self.wa?.ready ? 'webaudio' : 'element'; },
        get resyncs() { return self.resyncCount; },
        get latency() { return self.wa?.outputLatency ?? 0; },
        get element() { return self.el; },
      };
    }
    try {
      this.el.muted = true;
      this.el.src = SILENT_WAV;
      await this.el.play();
      this.el.pause();
      this.el.currentTime = 0;
      this.el.muted = false;
      // An AudioContext must also be created and resumed inside the original
      // tap — Android leaves a later one suspended, which would silently drop
      // us back to the stuttering element path.
      if (!this.ctx) {
        const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
        if (Ctor) {
          this.ctx = new Ctor({ latencyHint: 'playback' }) as AudioContext;
          this.wa = new WebAudioPlayer(this.ctx);
          (window as any).__syncWA = this.wa; // diagnostics / e2e only
        }
      }
      if (this.ctx?.state === 'suspended') { try { await this.ctx.resume(); } catch {} }
      // Unlock a SECOND element in the same gesture: Android blocks a fresh
      // <audio> created later, which is why the host's live microphone was
      // silent on a real phone even though the track arrived.
      if (!this.micAudio) {
        const m = new Audio();
        (m as any).playsInline = true;
        m.autoplay = true;
        m.muted = true;
        m.src = SILENT_WAV;
        try { await m.play(); m.pause(); } catch { /* best effort */ }
        m.muted = false;
        this.micAudio = m;
      }
      this.audioEnabled = true;
      this.keepPlayingWhenLocked();
      this.set({ phase: 'AUDIO_READY', error: null, info: null });
      if (this.hostTrack && this.hostTrack !== this.trackId) this.ensureTrack(this.hostTrack);
      this.loadAudio();
      if (this.transportPlaying) this.catchUp();
      return true;
    } catch {
      this.audioEnabled = false;
      this.set({ phase: 'AUDIO_DISABLED', error: 'Your browser blocked audio. Tap Enable Speaker.' });
      return false;
    }
  }

  get isAudioEnabled() { return this.audioEnabled; }

  private loadAudio() {
    const el = this.el;
    if (!el || !this.objectUrl || !this.trackId) return;
    // compare the actual source, not just the id: after a host refresh the id
    // is the same but the blob behind it is new
    // while the element is streaming this very song from the cloud, leave it
    // alone: swapping to the blob would restart it. The decoded engine takes
    // over (installBuffer) when it is ready.
    const streaming = this.streamingId === this.trackId;
    if (!streaming && (el.dataset.audioId !== this.trackId || el.src !== this.objectUrl)) {
      el.src = this.objectUrl;
      el.dataset.audioId = this.trackId;
      el.load();
    }
    // the element must go through the mixer too, or every slider does
    // nothing whenever the element (not the decoded buffer) is making the sound
    this.wa?.attachElement(el);
    this.decodeForExactPlayback();
    this.applyVolume();
  }

  /**
   * Decode the song into memory so playback can be scheduled exactly.
   *
   * Three real bugs lived here:
   *  1. `if (this.decoding) return` — a switch during a decode skipped the NEW
   *     song's decode for good, and the OLD decode then installed the OLD
   *     song's audio under the new title.
   *  2. A failed decode (unsupported format / out of memory) was swallowed
   *     and schedulePlay then waited for a buffer that would never come:
   *     "Preparing the song…" forever, no sound.
   *  3. Every switch paid the full decode (seconds, on a phone) at the worst
   *     possible moment. Now the host announces the next song and we decode
   *     it in the background, so the switch just installs a finished buffer.
   */
  private decodedId: string | null = null;
  private static readonly PREPARING = 'Preparing the song on this phone — it will join in a moment.';

  /** true while we are still waiting for a buffer that can actually arrive */
  private decodePending() {
    if (this.trackId && this.streamingId === this.trackId) return false;   // the element is already playing it
    return !!this.wa && !this.wa.ready && !(this.trackId && this.decodeFailed.has(this.trackId));
  }

  private decodeForExactPlayback() {
    const id = this.trackId;
    const blob = this.blob;
    if (!this.wa || !blob || !id || this.decodedId === id || this.decodeFailed.has(id)) return;
    const done = this.decodedBufs.get(id);
    if (done) { this.installBuffer(id, done, false); return; }      // pre-decoded: instant
    void this.decodeOnce(id, blob).then((buf) => {
      if (this.trackId !== id) return;            // the host moved on while we decoded: drop it
      if (!buf) {                                 // cannot decode: fall back to the element
        this.set({ info: null });
        if (this.transportPlaying && this.audioEnabled) this.catchUp();
        return;
      }
      this.installBuffer(id, buf, true);
    });
  }

  private decodeOnce(id: string, blob: Blob): Promise<AudioBuffer | null> {
    const have = this.decodedBufs.get(id);
    if (have) return Promise.resolve(have);
    const wa = this.wa;
    if (!wa) return Promise.resolve(null);
    let job = this.decodeJobs.get(id);
    if (!job) {
      job = wa.decode(blob)
        .then((buf) => { this.decodedBufs.set(id, buf); this.trimDecoded(); return buf as AudioBuffer | null; })
        .catch(() => { this.decodeFailed.add(id); return null; })
        .finally(() => { this.decodeJobs.delete(id); });
      this.decodeJobs.set(id, job);
    }
    return job;
  }

  /** keep decoded audio for the current and the announced next song only */
  private trimDecoded() {
    for (const k of [...this.decodedBufs.keys()]) {
      if (k !== this.trackId && k !== this.nextHint) this.decodedBufs.delete(k);
    }
  }

  private installBuffer(id: string, buf: AudioBuffer, resume: boolean) {
    if (!this.wa || this.trackId !== id || this.decodedId === id) return;
    this.wa.setBuffer(buf);
    this.decodedId = id;
    if (this.streamingId === id) this.streamingId = null;   // the exact engine has taken over
    this.set({
      duration: buf.duration, bufferedPct: 100,
      info: this.state.info === P2PSpeakerClient.PREPARING ? null : this.state.info,
    });
    this.applyVolume();
    if (resume && this.transportPlaying && this.audioEnabled) {
      // hand over from the element mid-song without a gap
      try { this.el?.pause(); } catch {}
      this.catchUp();
    }
  }

  /** Decode the announced next song in the background, once things are quiet. */
  private schedulePredecode() {
    window.clearTimeout(this.predecodeTimer);
    this.predecodeTimer = window.setTimeout(() => this.predecodeNext(), 1500);
    this.timers.push(this.predecodeTimer);
  }

  private predecodeNext() {
    const id = this.nextHint;
    if (!id || !this.audioEnabled || !this.wa || id === this.trackId) return;
    if (this.decodedBufs.has(id) || this.decodeJobs.has(id) || this.decodeFailed.has(id)) return;
    // let the song that is playing finish its own decode first
    if (this.trackId && this.decodedId !== this.trackId && !this.decodeFailed.has(this.trackId)) {
      this.schedulePredecode();
      return;
    }
    // a very long song is hundreds of MB of PCM: never hold two of those
    if (this.wa.bytesHeld > 160 * 1024 * 1024) return;
    const held = this.mem.get(id);
    if (!held) return;                  // not here yet — adoptTrack() will call us again
    void this.decodeOnce(id, held.blob);
  }

  private applyVolume() {
    const v = this.state.muted ? 0 : this.state.volume;
    if (this.el) this.el.volume = v;
    if (this.wa) this.wa.volume = v;
    this.voiceMixer?.setMaster(v);
    if (this.micAudio && !this.micAudio.muted) this.micAudio.volume = v;
  }

  private updateBuffered() {
    const a = this.audio;
    if (!a || !a.duration) return;
    if (this.wa?.ready) { this.set({ bufferedPct: 100 }); return; }
    const end = a.buffered.length ? a.buffered.end(a.buffered.length - 1) : 0;
    this.set({ bufferedPct: Math.min(100, (end / a.duration) * 100) });
  }

  /**
   * Per-device output delay, in milliseconds.
   *
   * Aligning `currentTime` is not enough in the real world: every phone has
   * its own audio output latency (decoder + mixer + Bluetooth), easily 50–250
   * ms apart, and that is exactly what you hear as an echo between two phones.
   * No browser API reports it, so this is a manual nudge the listener can set
   * once per phone; it is remembered on that device.
   */
  /** Always 0 — the host-driven bias loop was removed (see p2pHost.ts). */
  private clockBias = 0;

  get outputOffsetMs() { return Number(localStorage.getItem('sm.outOffset') || 0); }
  setOutputOffsetMs(ms: number) {
    const v = Math.max(-500, Math.min(500, Math.round(ms)));
    localStorage.setItem('sm.outOffset', String(v));
    this.set({});
    this.realign();
  }

  private targetPosition() {
    return projectPosition(
      this.basePosition, this.baseHostTime,
      this.clock.now() + this.outputOffsetMs + this.clockBias, this.transportPlaying,
      this.state.duration || Infinity,
    );
  }

  /** Snap onto the timeline now (used when the clock estimate jumps). */
  private realign() {
    const a = this.audio;
    if (!a || !this.audioEnabled || !this.transportPlaying || a.paused) return;
    if (this.wa?.ready) { this.resyncExact(); return; }
    const target = this.targetPosition();
    if (Math.abs(a.currentTime - target) < 0.03) return;
    try { a.currentTime = target; } catch {}
    a.playbackRate = 1;
    this.drift.reset();
  }

  private schedulePlay(position: number, startAt: number) {
    const a = this.audio;
    if (!a) return;
    // The element stutters — that is the whole reason the decoded player
    // exists. So if the song is not decoded yet we stay SILENT and say so,
    // rather than producing the broken sound and "fixing" it later.
    if (this.decodePending()) {
      this.decodeForExactPlayback();
      this.set({ phase: 'SYNCING', info: P2PSpeakerClient.PREPARING });
      return;
    }
    if (this.playTimer) window.clearTimeout(this.playTimer);
    this.set({ phase: 'SYNCING' });

    // Decoded path: no setTimeout, no play() latency, no guessing. We hand the
    // audio hardware the exact instant to begin and it obeys to the sample.
    if (this.wa?.ready) {
      const leadMs = startAt - this.clock.now() - this.outputOffsetMs;
      this.settlingSince = Date.now();
      this.wa.scheduleStart(position, leadMs / 1000);
      this.armJoinChecks();
      this.set({ phase: 'PLAYING', playing: true });
      this.drift.reset();
      return;
    }

    const arm = () => {
      const lead = startAt - this.clock.now();
      if (lead <= 0) { this.catchUp(); return; }
      try { a.currentTime = position; } catch {}
      this.playTimer = window.setTimeout(() => {
        // The host may have paused, stopped or seeked while we were waiting:
        // a stale scheduled start used to make one phone play on its own.
        if (!this.transportPlaying || this.baseHostTime !== startAt) return;
        const err = startAt - this.clock.now();
        try { a.currentTime = position - Math.min(0, err) / 1000; } catch {}
        void a.play()
          .then(() => {
            if (!this.transportPlaying) { try { a.pause(); } catch {} return; }
            this.set({ phase: 'PLAYING', playing: true });
            // Slow decoders can begin hundreds of ms late, and a data channel's
            // clock keeps improving in the first seconds, so check twice.
            for (const delay of [400, 1500]) {
              window.setTimeout(() => {
                if (!this.transportPlaying || a.paused) return;
                const t = this.targetPosition();
                if (Math.abs(a.currentTime - t) > 0.08) { try { a.currentTime = t; } catch {} }
              }, delay);
            }
          })
          .catch(() => this.set({ phase: 'AUDIO_DISABLED', error: 'Your browser blocked audio. Tap Enable Speaker.' }));
      }, Math.max(0, lead - 5));
    };
    if (a.readyState >= 2) arm();
    else a.addEventListener('loadeddata', arm, { once: true });
  }

  /** Late join / resync — a start that is still in the future must be scheduled. */
  private catchUp() {
    const a = this.audio;
    if (!a || !this.audioEnabled) return;
    if (this.decodePending()) {
      this.decodeForExactPlayback();
      this.set({ phase: 'SYNCING', info: P2PSpeakerClient.PREPARING });
      return;
    }
    const untilStart = this.baseHostTime - this.clock.now();
    if (this.transportPlaying && untilStart > 20) { this.schedulePlay(this.basePosition, this.baseHostTime); return; }
    const target = this.targetPosition();
    void target;
    if (this.wa?.ready && this.transportPlaying) {
      this.settlingSince = Date.now();
      this.resyncExact();
      this.armJoinChecks();
      this.set({ phase: 'PLAYING', playing: true });
      return;
    }
    try { a.currentTime = target; } catch {}
    if (this.transportPlaying) {
      void a.play()
        .then(() => this.set({ phase: 'PLAYING', playing: true }))
        .catch(() => this.set({ phase: 'AUDIO_DISABLED', error: 'Your browser blocked audio. Tap Enable Speaker.' }));
    }
  }

  /**
   * Survive a locked screen.
   *
   * Android keeps a page's <audio> playing when the screen goes off, but only
   * if the system sees it as real media playback — so we publish Media Session
   * metadata and keep the session's play/pause handlers pointed at the host.
   * We also hold a screen wake lock while the page is visible, which is what
   * stops a phone from suspending Wi-Fi mid-song. The honest limit: the tab
   * must stay open, and some battery savers will still stop it.
   */
  /**
   * Android suspends an AudioContext when the screen goes off or the system
   * takes the audio focus, and a suspended context is simply silence. Watch
   * for it and bring it back, then land exactly back on the timeline.
   */
  private keepContextAwake() {
    const revive = () => {
      const ctx = this.ctx;
      if (!ctx || !this.audioEnabled) return;
      if (ctx.state !== 'running') {
        void ctx.resume()
          .then(() => { if (this.transportPlaying) this.resyncExact(); })
          .catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', revive);
    window.addEventListener('focus', revive);
    this.timers.push(window.setInterval(revive, 2000));
  }

  private keepPlayingWhenLocked() {
    this.keepContextAwake();
    try {
      const ms = (navigator as any).mediaSession;
      if (ms) {
        ms.setActionHandler?.('play', () => { /* the host owns transport */ });
        ms.setActionHandler?.('pause', () => { /* ignore: the host owns transport */ });
        ms.setActionHandler?.('stop', () => { /* ignore */ });
        ms.metadata = new (window as any).MediaMetadata({
          title: this.state.trackTitle || 'Sync Music',
          artist: 'Synchronized speaker',
          album: this.state.sessionName || 'Sync Music',
        });
        ms.playbackState = 'playing';
      }
    } catch { /* Media Session is optional */ }

    const lock = async () => {
      try {
        if (document.visibilityState !== 'visible') return;
        this.wakeLock = await (navigator as any).wakeLock?.request('screen');
      } catch { /* denied or unsupported — playback still continues */ }
    };
    void lock();
    document.addEventListener('visibilitychange', () => {
      void lock();
      // Coming back from a locked screen: re-check our place in the timeline.
      if (document.visibilityState === 'visible' && this.transportPlaying) this.realign();
    });
  }

  private wakeLock: any = null;
  private cachedIds: string[] = [];
  private bigErrors = 0;
  private lastErr = 0;

  private startReporting() {
    const report = () => {
      const a = this.audio;
      const buffered = a && a.buffered.length ? a.buffered.end(a.buffered.length - 1) - a.currentTime : 0;
      this.send({
        type: 'STATUS', position: a?.currentTime ?? 0, atHostTime: this.clock.now(),
        rate: a?.playbackRate ?? 1, playing: !!a && !a.paused, buffered: Math.max(0, buffered),
        clockRtt: Math.round(this.clock.rtt), clockSynced: this.clock.synced,
        clockSamples: this.clock.sampleCount,
        seq: this.appliedSeq,
        // a song we hold in memory counts as "had" even if it is not the live one yet,
        // otherwise the host keeps re-sending a file that is already here
        haveTrack: this.hostTrack && this.mem.has(this.hostTrack) ? this.hostTrack : this.haveTrack,
        cached: this.cachedIds,
        selfDriftMs: a && !a.paused ? Math.round((a.currentTime - this.targetPosition()) * 1000) : 0,
      });
      this.reportTimer = window.setTimeout(report, 600);
    };
    report();
    this.connTimers.push(window.setInterval(() => this.correctDrift(), 500));
  }

  /**
   * Put the decoded player exactly on the timeline.
   *
   * With Web Audio this is cheap and precise — we simply tell the hardware to
   * begin a fraction of a second from now at the position the song will have
   * reached by then. Unlike an element seek there is no re-buffering, so it is
   * the right tool for anything above a few tens of milliseconds.
   */
  private smoothErr: number | null = null;
  /** when playback last (re)started — the clock estimate is youngest here */
  private settlingSince = 0;
  resyncCount = 0;
  private lastResyncAt = 0;

  /**
   * Join checks.
   *
   * A phone that joins mid-song, or comes back after the host refreshed, is
   * aligned against a clock estimate that is seconds old at best. The steady
   * loop deliberately corrects slowly, which left a late joiner audibly
   * behind for a long time. So right after a join we look twice more and
   * force an exact alignment if it is still out — this window is short and
   * nobody is settled into the song yet.
   */
  private joinTimers: number[] = [];
  private lastArmAt = 0;
  private armJoinChecks() {
    // STATE arrives continuously and every one of them used to re-arm these
    // checks, so the "short window after a join" never ended and the forced
    // corrections became a steady chop. Arm them once per join, and never
    // more than once every 3 s.
    if (Date.now() - this.lastArmAt < 3000) return;
    this.lastArmAt = Date.now();
    this.joinTimers.forEach((t) => window.clearTimeout(t));
    this.joinTimers = [];
    for (const delay of [700, 1700]) {
      this.joinTimers.push(window.setTimeout(() => {
        if (!this.transportPlaying || !this.wa?.ready || !this.audioEnabled) return;
        const err = this.wa.currentTime - this.targetPosition();
        // never while a file is still arriving: the reading is noise then
        if (Math.abs(err) > 0.04 && !this.incoming) { this.resyncExact(); this.smoothErr = 0; }
      }, delay));
    }
    this.timers.push(...this.joinTimers);
  }

  private resyncExact() {
    this.resyncCount++;
    this.lastResyncAt = Date.now();
    const wa = this.wa;
    if (!wa?.ready || !this.transportPlaying) return;
    const lead = 0.06;
    wa.playbackRate = 1;
    wa.scheduleStart(this.targetPosition() + lead, lead);
    this.smoothErr = null;
    this.drift.reset();
    this.bigErrors = 0;
  }

  private correctDrift() {
    const a = this.audio;
    // Wait for a usable offset, not a perfect one: right after a (re)connect
    // the estimate is still settling, and refusing to correct during those
    // seconds is exactly when a phone drifts audibly away from the others.
    const usable = this.clock.synced || this.clock.sampleCount >= 3;
    if (!a || !this.audioEnabled || !this.transportPlaying || a.paused || !usable) {
      if (a) this.set({ position: a.currentTime });
      return;
    }
    const target = this.targetPosition();
    const err = a.currentTime - target;

    // Decoded path.
    //
    // Restarting the source is sample-accurate, but it is still a restart: do
    // it twice a second and the listener hears chopping — which is exactly
    // what was happening (22 restarts in 20 s on the bench). A phone's clock
    // estimate jitters by tens of milliseconds over Wi-Fi, so correcting on
    // raw readings means chasing noise.
    //
    // So: smooth the error, then prefer the inaudible tool. A restart is the
    // last resort — a large error, confirmed three times in a row, and never
    // more often than once every 6 seconds.
    if (this.wa?.ready) {
      const fresh = Date.now() - this.settlingSince < 8000;
      this.smoothErr = this.smoothErr === null ? err
        : this.smoothErr * (fresh ? 0.3 : 0.6) + err * (fresh ? 0.7 : 0.4);
      const e = this.smoothErr;
      const since = Date.now() - this.lastResyncAt;

      // Two different problems, two different urgencies:
      //  - beyond ~120 ms the phone is plainly out (it just joined, or its
      //    clock jumped). That is already audible as an echo, so fix it after
      //    two agreeing samples, at most once every 2.5 s.
      //  - under that, it is slow drift: confirm three times and correct at
      //    most once every 6 s, because the correction itself can be heard.
      // Two regimes, because the two problems are not the same problem.
      //
      // SETTLING (the first 8 s after a start or a join): the clock estimate
      // is still young and a phone can land well off the beat. Converge fast
      // — a couple of corrections now, while the listener is still noticing
      // the song begin, is far better than an echo that lasts a minute.
      //
      // STEADY: the only thing left is slow drift, measured in tens of ms per
      // minute. Here a correction is the loudest thing in the room, so it is
      // the last resort: a big error, confirmed, and rarely.
      const settling = Date.now() - this.settlingSince < 8000;
      const urgent = Math.abs(e) > (settling ? 0.05 : 0.12);
      if (Math.abs(e) > (settling ? 0.05 : 0.15)) {
        this.bigErrors = Math.sign(e) === Math.sign(this.lastErr) ? this.bigErrors + 1 : 1;
        this.lastErr = e;
        const need = settling ? 1 : urgent ? 2 : 3;
        const gap = settling ? 900 : urgent ? 2500 : 6000;
        // While this phone is still receiving a file its main thread stalls on
        // every arriving chunk, so the position reading is noisy — and
        // restarting playback on a noisy reading is precisely the chopping
        // people hear. Ride it out on the rate change instead; the transfer is
        // over in seconds and the loop then corrects properly.
        const busy = !!this.incoming;
        if (this.bigErrors >= need && since > gap && !busy) {
          this.resyncExact();
          this.smoothErr = 0;
          this.set({ driftMs: Math.round(e * 1000), phase: 'PLAYING', position: a.currentTime });
          return;
        }
      } else {
        this.bigErrors = 0;
      }

      // Proportional, capped at 0.5%: closes 100 ms in about 20 s without a
      // pitch change anyone can hear, and never interrupts the waveform.
      const rate = Math.abs(e) < 0.012 ? 1 : 1 - Math.max(-0.005, Math.min(0.005, e * 0.05));
      a.playbackRate = rate;
      this.set({ position: a.currentTime, driftMs: Math.round(e * 1000), phase: 'PLAYING' });
      return;
    }
    // Safety net above the normal policy: a phone that is more than ~120 ms
    // out is plainly audible as an echo, and nudging playbackRate would take
    // tens of seconds to close that. Snap it, then let the gentle loop keep it
    // there. (Below this the policy still prefers an inaudible rate change.)
    // A phone's clock estimate jitters, especially on mobile data. Snapping on
    // a single bad sample is audible as a tick, and repeated ticks are exactly
    // the "ruk ruk" stutter. So a seek needs THREE consecutive readings that
    // agree, and in between we lean on the (inaudible) rate change.
    if (Math.abs(err) > 0.12) {
      this.bigErrors = Math.sign(err) === Math.sign(this.lastErr) ? this.bigErrors + 1 : 1;
      this.lastErr = err;
      if (this.bigErrors >= 3) {
        this.bigErrors = 0;
        try { a.currentTime = target; } catch {}
        a.playbackRate = 1;
        this.set({ position: a.currentTime, driftMs: Math.round(err * 1000), phase: 'PLAYING' });
        this.updateBuffered();
        return;
      }
      // With an exact start the error is small and slow, so nudge by 0.5%
      // (inaudible) rather than 2% (a noticeable pitch wobble).
      a.playbackRate = err > 0 ? 0.995 : 1.005;
      this.set({ position: a.currentTime, driftMs: Math.round(err * 1000), phase: 'PLAYING' });
      this.updateBuffered();
      return;
    }
    this.bigErrors = 0;
    const c = this.drift.evaluate(a.currentTime, target);
    if (c.action === 'rate') a.playbackRate = c.rate;
    if (c.action === 'seek') { a.currentTime = c.targetPosition; a.playbackRate = 1; }
    this.set({ position: a.currentTime, driftMs: Math.round(c.driftMs), phase: 'PLAYING' });
    this.updateBuffered();
  }

  disconnect() {
    this.closed = true;
    this.started = false;
    this.clearConnTimers();
    this.timers.forEach((t) => { window.clearTimeout(t); window.clearInterval(t); });
    if (this.playTimer) window.clearTimeout(this.playTimer);
    try { this.conn?.close(); } catch {}
    try { this.peer?.destroy(); } catch {}
    try { this.el?.pause(); } catch {}
    this.wa?.dispose();
    this.mem.clear(); this.decodedBufs.clear(); this.decodeJobs.clear();
    try { void this.ctx?.close(); } catch {}
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.set({ conn: 'disconnected', phase: 'DISCONNECTED' });
  }
}

function deviceId(): string {
  const KEY = 'sync-music.deviceId';
  let v = localStorage.getItem(KEY);
  if (!v) {
    v = (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)) + '-' + Date.now().toString(36);
    localStorage.setItem(KEY, v);
  }
  return v;
}
