import type { WebSocket } from 'ws';
import {
  AudioTrack, PlaybackState, ServerMessage, SessionPublic, SpeakerInfo, SYNC, TransportState,
  statusIntervalMs,
} from '@sync-music/protocol';
import { projectPosition } from '@sync-music/sync-engine';
import { config } from './config';
import { log } from './logger';
import type { Bus } from './bus';
import { randomId } from './security';

/* ------------------------------------------------------------------ */

export interface Conn {
  id: string;
  ws: WebSocket;
  role: 'speaker' | 'host' | 'anon';
  sessionId: string | null;
  speakerId: string | null;
  alive: boolean;
  lastMsg: number;
  msgBudget: number; // simple per-connection rate limiting
}

interface SpeakerRecord extends SpeakerInfo {
  deviceId: string;
  connId: string | null;
  /** position/state last reported, with the server time it was reported at */
  reportedPosition: number;
  reportedAt: number;
}

interface SessionRecord {
  sessionId: string;
  name: string;
  hostId: string;
  status: 'active' | 'ended';
  createdAt: number;
  expiresAt: number;
  transport: TransportState;
  /** monotonically increasing index used to name "Speaker N" */
  speakerSeq: number;
}

interface LocalSession {
  rec: SessionRecord;
  speakers: Map<string, SpeakerRecord>;
  hostConns: Set<Conn>;
  speakerConns: Map<string, Conn>; // speakerId -> conn (dynamic registry, no cap)
}

const INSTANCE_ID = randomId(6);
const CH = (sessionId: string) => `sm:sess:${sessionId}`;
const KEY_SESSION = (id: string) => `sm:session:${id}`;
const KEY_INSTANCE_COUNT = (id: string) => `sm:count:${id}:${INSTANCE_ID}`;
const KEY_COUNT_PATTERN = (id: string) => `sm:count:${id}:*`;

function emptyTransport(): TransportState {
  return {
    state: 'idle', trackId: null, position: 0, positionAtServerTime: Date.now(),
    volume: 1, playlist: [], trackIndex: -1, autoNext: true,
  };
}

export class SessionHub {
  /** sessionId -> live connections. THE registry. Grows with demand; no product cap. */
  private local = new Map<string, LocalSession>();
  private totalConnections = 0;

  constructor(private bus: Bus) {
    setInterval(() => this.tick(), 1000).unref();
    setInterval(() => this.publishLocalCounts(), 5000).unref();
  }

  get instanceId() { return INSTANCE_ID; }
  get connectionCount() { return this.totalConnections; }
  /** Infrastructure guard only. */
  atCapacity() { return this.totalConnections >= config.maxConnectionsPerInstance; }

  /* ----------------------------- lifecycle ----------------------------- */

  async createSession(name: string): Promise<SessionRecord> {
    const rec: SessionRecord = {
      sessionId: randomId(18),
      hostId: randomId(12),
      name: name?.trim() ? name.trim().slice(0, 60) : 'Music Session',
      status: 'active',
      createdAt: Date.now(),
      expiresAt: Date.now() + config.sessionTtlMs,
      transport: emptyTransport(),
      speakerSeq: 0,
    };
    this.local.set(rec.sessionId, { rec, speakers: new Map(), hostConns: new Set(), speakerConns: new Map() });
    await this.persist(rec);
    await this.bus.subscribe(CH(rec.sessionId), (ev) => this.onBusEvent(rec.sessionId, ev));
    log.info(`session created ${rec.sessionId} "${rec.name}"`);
    return rec;
  }

  private async persist(rec: SessionRecord) {
    await this.bus.setJson(KEY_SESSION(rec.sessionId), rec, Math.max(1000, rec.expiresAt - Date.now()));
  }

  /** Load a session into this instance (needed when another instance created it). */
  async ensureLocal(sessionId: string): Promise<LocalSession | null> {
    const existing = this.local.get(sessionId);
    if (existing) return existing.rec.status === 'active' ? existing : null;
    const rec = await this.bus.getJson<SessionRecord>(KEY_SESSION(sessionId));
    if (!rec || rec.status !== 'active') return null;
    const ls: LocalSession = { rec, speakers: new Map(), hostConns: new Set(), speakerConns: new Map() };
    this.local.set(sessionId, ls);
    await this.bus.subscribe(CH(sessionId), (ev) => this.onBusEvent(sessionId, ev));
    return ls;
  }

  async listActiveSessions(): Promise<SessionPublic[]> {
    const out: SessionPublic[] = [];
    const keys = await this.bus.keys('sm:session:*');
    for (const k of keys) {
      const rec = await this.bus.getJson<SessionRecord>(k);
      if (!rec || rec.status !== 'active' || rec.expiresAt < Date.now()) continue;
      out.push({
        sessionId: rec.sessionId,
        name: rec.name,
        speakerCount: await this.speakerCount(rec.sessionId),
        hostOnline: (this.local.get(rec.sessionId)?.hostConns.size ?? 0) > 0 || (await this.hostOnlineShared(rec.sessionId)),
        createdAt: rec.createdAt,
      });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  private async hostOnlineShared(sessionId: string) {
    const v = await this.bus.getJson<{ online: boolean }>(`sm:host:${sessionId}`);
    return !!v?.online;
  }

  async endSession(sessionId: string) {
    const ls = this.local.get(sessionId);
    if (ls) ls.rec.status = 'ended';
    await this.bus.del(KEY_SESSION(sessionId));
    await this.bus.publish(CH(sessionId), { kind: 'ended', from: INSTANCE_ID });
    this.broadcast(sessionId, { type: 'SESSION_ENDED', reason: 'Host ended the session.' });
    this.local.delete(sessionId);
  }

  /* --------------------------- connections ----------------------------- */

  registerConnection(conn: Conn) { this.totalConnections++; }

  async attachSpeaker(conn: Conn, sessionId: string, deviceId: string, knownSpeakerId?: string | null) {
    const ls = await this.ensureLocal(sessionId);
    if (!ls) return null;

    if (config.maxSpeakersPerSessionInfra > 0 &&
        (await this.speakerCount(sessionId)) >= config.maxSpeakersPerSessionInfra &&
        !ls.speakers.has(knownSpeakerId ?? '')) {
      return 'CAPACITY' as const;
    }

    // Reconnect path: same deviceId (or previously issued speakerId) reclaims identity.
    let rec = (knownSpeakerId && ls.speakers.get(knownSpeakerId))
      || [...ls.speakers.values()].find((s) => s.deviceId === deviceId);

    if (!rec) {
      ls.rec.speakerSeq += 1;
      const index = ls.rec.speakerSeq;
      rec = {
        id: randomId(10), deviceId, name: `Speaker ${index}`, group: 'ALL',
        status: 'connected', muted: false, latencyMs: 0, driftMs: 0, state: 'idle',
        bufferedSeconds: 0, joinedAt: Date.now(), lastSeen: Date.now(),
        connId: conn.id, reportedPosition: 0, reportedAt: Date.now(),
      };
      ls.speakers.set(rec.id, rec);
      await this.persist(ls.rec);
    } else {
      rec.status = 'connected';
      rec.lastSeen = Date.now();
      rec.connId = conn.id;
    }

    const prev = ls.speakerConns.get(rec.id);
    if (prev && prev.id !== conn.id) { try { prev.ws.close(4000, 'replaced'); } catch {} }
    ls.speakerConns.set(rec.id, conn);

    conn.role = 'speaker';
    conn.sessionId = sessionId;
    conn.speakerId = rec.id;
    await this.publishLocalCounts();
    this.scheduleHostSnapshot(sessionId);
    return { ls, rec, index: Number(rec.name.replace(/\D+/g, '')) || 0 };
  }

  async attachHost(conn: Conn, sessionId: string) {
    const ls = await this.ensureLocal(sessionId);
    if (!ls) return null;
    conn.role = 'host';
    conn.sessionId = sessionId;
    ls.hostConns.add(conn);
    await this.bus.setJson(`sm:host:${sessionId}`, { online: true }, 60_000);
    await this.bus.publish(CH(sessionId), { kind: 'host', online: true, from: INSTANCE_ID });
    this.broadcastSpeakers(sessionId, { type: 'HOST_CONNECTED' });
    this.scheduleHostSnapshot(sessionId);
    return ls;
  }

  async detach(conn: Conn) {
    this.totalConnections = Math.max(0, this.totalConnections - 1);
    const sessionId = conn.sessionId;
    if (!sessionId) return;
    const ls = this.local.get(sessionId);
    if (!ls) return;

    if (conn.role === 'host') {
      ls.hostConns.delete(conn);
      if (ls.hostConns.size === 0) {
        await this.bus.setJson(`sm:host:${sessionId}`, { online: false }, 60_000);
        await this.bus.publish(CH(sessionId), { kind: 'host', online: false, from: INSTANCE_ID });
        this.broadcastSpeakers(sessionId, { type: 'HOST_DISCONNECTED' });
      }
      return;
    }
    if (conn.role === 'speaker' && conn.speakerId) {
      const rec = ls.speakers.get(conn.speakerId);
      if (rec && rec.connId === conn.id) {
        rec.status = 'reconnecting';   // grace period, identity is preserved
        rec.lastSeen = Date.now();
        rec.connId = null;
      }
      ls.speakerConns.delete(conn.speakerId);
      await this.publishLocalCounts();
      this.scheduleHostSnapshot(sessionId);
    }
  }

  /* ------------------------------ counts ------------------------------- */

  private async publishLocalCounts() {
    for (const [sessionId, ls] of this.local) {
      await this.bus.setJson(KEY_INSTANCE_COUNT(sessionId), { n: ls.speakerConns.size }, 15_000);
    }
  }

  /** Dynamic count across all instances. Never compared to a constant. */
  async speakerCount(sessionId: string): Promise<number> {
    if (this.bus.kind === 'memory') return this.local.get(sessionId)?.speakerConns.size ?? 0;
    const keys = await this.bus.keys(KEY_COUNT_PATTERN(sessionId));
    let n = 0;
    for (const k of keys) n += (await this.bus.getJson<{ n: number }>(k))?.n ?? 0;
    return n;
  }

  /* ----------------------------- messaging ----------------------------- */

  send(conn: Conn, msg: ServerMessage) {
    if (conn.ws.readyState !== 1) return;
    try { conn.ws.send(JSON.stringify(msg)); } catch (e) { log.error('ws send failed', e); }
  }

  /** Broadcast to this instance's speakers (host excluded). */
  broadcastSpeakers(sessionId: string, msg: ServerMessage) {
    const ls = this.local.get(sessionId);
    if (!ls) return;
    const payload = JSON.stringify(msg);
    for (const c of ls.speakerConns.values()) {
      if (c.ws.readyState === 1) { try { c.ws.send(payload); } catch {} }
    }
  }

  broadcast(sessionId: string, msg: ServerMessage) {
    this.broadcastSpeakers(sessionId, msg);
    const ls = this.local.get(sessionId);
    if (ls) for (const h of ls.hostConns) this.send(h, msg);
  }

  /** Publish to every instance, which then fans out locally. Payload is tiny. */
  async fanout(sessionId: string, msg: ServerMessage, alsoHost = true) {
    await this.bus.publish(CH(sessionId), { kind: 'msg', msg, alsoHost, from: INSTANCE_ID });
    if (this.bus.kind === 'memory') return; // memory bus already delivered to us
  }

  private onBusEvent(sessionId: string, ev: any) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.kind === 'msg') {
      if (ev.alsoHost) this.broadcast(sessionId, ev.msg);
      else this.broadcastSpeakers(sessionId, ev.msg);
    } else if (ev.kind === 'transport' && ev.from !== INSTANCE_ID) {
      const ls = this.local.get(sessionId);
      if (ls) ls.rec.transport = ev.transport;
    } else if (ev.kind === 'host' && ev.from !== INSTANCE_ID) {
      this.broadcastSpeakers(sessionId, ev.online ? { type: 'HOST_CONNECTED' } : { type: 'HOST_DISCONNECTED' });
    } else if (ev.kind === 'ended' && ev.from !== INSTANCE_ID) {
      this.broadcastSpeakers(sessionId, { type: 'SESSION_ENDED', reason: 'Host ended the session.' });
      this.local.delete(sessionId);
    }
  }

  /* ----------------------------- transport ----------------------------- */

  getSession(sessionId: string) { return this.local.get(sessionId) ?? null; }

  transport(sessionId: string): TransportState {
    return this.local.get(sessionId)?.rec.transport ?? emptyTransport();
  }

  currentTrack(sessionId: string): AudioTrack | null {
    const t = this.transport(sessionId);
    return t.playlist.find((p) => p.id === t.trackId) ?? null;
  }

  /**
   * Transport as it should be reported to a client.
   *
   * While a SYNC_PLAY is still in its pre-roll (positionAtServerTime is in the
   * FUTURE) the base must be sent untouched. Re-projecting it onto "now" would
   * tell a late joiner "you are playing, at position 0, as of now", and it would
   * start a full lead-time (1.5 s) ahead of everybody else.
   */
  reportableTransport(sessionId: string, at = Date.now()): TransportState {
    const t = this.transport(sessionId);
    if (t.positionAtServerTime > at) return { ...t };
    return { ...t, position: this.serverPosition(sessionId, at), positionAtServerTime: at };
  }

  /** Authoritative position right now, projected from the last state change. */
  serverPosition(sessionId: string, at = Date.now()) {
    const t = this.transport(sessionId);
    const dur = this.currentTrack(sessionId)?.duration || Infinity;
    return projectPosition(t.position, t.positionAtServerTime, at, t.state === 'playing', dur);
  }

  async mutateTransport(sessionId: string, patch: Partial<TransportState>) {
    const ls = this.local.get(sessionId);
    if (!ls) return;
    ls.rec.transport = { ...ls.rec.transport, ...patch };
    await this.persist(ls.rec);
    await this.bus.publish(CH(sessionId), { kind: 'transport', transport: ls.rec.transport, from: INSTANCE_ID });
  }

  /* -------------------------- host aggregation -------------------------- */

  private snapshotTimers = new Map<string, NodeJS.Timeout>();

  /** Debounced: never spam the host, even if 500 speakers join at once. */
  scheduleHostSnapshot(sessionId: string, delay = 400) {
    if (this.snapshotTimers.has(sessionId)) return;
    const t = setTimeout(() => {
      this.snapshotTimers.delete(sessionId);
      void this.sendHostSnapshot(sessionId);
    }, delay);
    t.unref?.();
    this.snapshotTimers.set(sessionId, t);
  }

  async sendHostSnapshot(sessionId: string) {
    const ls = this.local.get(sessionId);
    if (!ls || ls.hostConns.size === 0) return;
    const all = [...ls.speakers.values()].filter((s) => s.status !== 'disconnected');
    const limit = config.speakerSnapshotLimit;
    const speakers = all.slice(0, limit).map((s) => ({
      id: s.id, name: s.name, group: s.group, status: s.status, muted: s.muted,
      latencyMs: Math.round(s.latencyMs), driftMs: Math.round(s.driftMs), state: s.state,
      bufferedSeconds: s.bufferedSeconds, joinedAt: s.joinedAt, lastSeen: s.lastSeen,
    }));
    const playing = all.filter((s) => s.state === 'playing');
    const avgDrift = playing.length ? playing.reduce((a, s) => a + Math.abs(s.driftMs), 0) / playing.length : 0;
    const avgLat = all.length ? all.reduce((a, s) => a + s.latencyMs, 0) / all.length : 0;
    const msg: ServerMessage = {
      type: 'SPEAKERS_SNAPSHOT',
      speakerCount: await this.speakerCount(sessionId),
      averageDriftMs: Math.round(avgDrift),
      averageLatencyMs: Math.round(avgLat),
      speakers,
      truncated: all.length > limit,
    };
    for (const h of ls.hostConns) this.send(h, msg);
  }

  /** Speaker telemetry: aggregated server-side, never rebroadcast to speakers. */
  reportStatus(conn: Conn, position: number, state: PlaybackState, buffered: number) {
    const sessionId = conn.sessionId; if (!sessionId || !conn.speakerId) return;
    const ls = this.local.get(sessionId); if (!ls) return;
    const rec = ls.speakers.get(conn.speakerId); if (!rec) return;
    const now = Date.now();
    rec.state = state;
    rec.bufferedSeconds = buffered;
    rec.reportedPosition = position;
    rec.reportedAt = now;
    rec.lastSeen = now;
    const target = this.serverPosition(sessionId, now);
    rec.driftMs = this.transport(sessionId).state === 'playing' && state === 'playing'
      ? (position - target) * 1000 : 0;
    this.scheduleHostSnapshot(sessionId, 1000);
  }

  setLatency(conn: Conn, rttMs: number) {
    if (!conn.sessionId || !conn.speakerId) return;
    const rec = this.local.get(conn.sessionId)?.speakers.get(conn.speakerId);
    if (rec) rec.latencyMs = rec.latencyMs ? rec.latencyMs * 0.7 + (rttMs / 2) * 0.3 : rttMs / 2;
  }

  renameSpeaker(sessionId: string, speakerId: string, name?: string, group?: string) {
    const ls = this.local.get(sessionId); if (!ls) return;
    const rec = ls.speakers.get(speakerId); if (!rec) return;
    if (name) rec.name = name.slice(0, 40);
    if (group) rec.group = group.slice(0, 24);
    const c = ls.speakerConns.get(speakerId);
    if (c) this.send(c, { type: 'RENAMED', name: rec.name, group: rec.group });
    this.scheduleHostSnapshot(sessionId, 100);
  }

  muteGroup(sessionId: string, group: string, muted: boolean) {
    const ls = this.local.get(sessionId); if (!ls) return;
    for (const rec of ls.speakers.values()) {
      if (group === 'ALL' || rec.group === group) {
        rec.muted = muted;
        const c = ls.speakerConns.get(rec.id);
        if (c) this.send(c, { type: 'MUTE', muted });
      }
    }
    this.scheduleHostSnapshot(sessionId, 100);
  }

  statusInterval(sessionId: string) {
    return statusIntervalMs(this.local.get(sessionId)?.speakerConns.size ?? 0);
  }

  /* ------------------------------- tick -------------------------------- */

  private tick() {
    const now = Date.now();
    for (const [sessionId, ls] of this.local) {
      if (ls.rec.expiresAt < now) { void this.endSession(sessionId); continue; }
      for (const [id, rec] of ls.speakers) {
        if (rec.status === 'reconnecting' && now - rec.lastSeen > config.speakerGraceMs) {
          ls.speakers.delete(id);
          this.scheduleHostSnapshot(sessionId, 500);
        }
      }
      // auto-next at end of track
      const t = ls.rec.transport;
      const track = ls.rec.transport.playlist.find((p) => p.id === t.trackId);
      if (t.state === 'playing' && t.autoNext && track && track.duration > 0) {
        if (this.serverPosition(sessionId, now) >= track.duration - 0.15) {
          void this.advance(sessionId, +1, true);
        }
      }
    }
  }

  /** NEXT / PREV. Returns false when there is nothing to move to. */
  async advance(sessionId: string, dir: 1 | -1, autoplay: boolean) {
    const ls = this.local.get(sessionId); if (!ls) return false;
    const t = ls.rec.transport;
    if (t.playlist.length === 0) return false;
    let idx = t.trackIndex < 0 ? 0 : t.trackIndex + dir;
    if (idx >= t.playlist.length) {
      if (!t.autoNext) { await this.stop(sessionId); return false; }
      idx = 0;
      if (!autoplay) return false;
    }
    if (idx < 0) idx = 0;
    const track = t.playlist[idx];
    await this.mutateTransport(sessionId, { trackIndex: idx, trackId: track.id, position: 0, positionAtServerTime: Date.now() });
    await this.fanout(sessionId, { type: 'TRACK_CHANGED', audioId: track.id, position: 0 });
    if (autoplay || t.state === 'playing') await this.play(sessionId, track.id, 0);
    return true;
  }

  /**
   * How far ahead to schedule a start.
   *
   * A fixed 1.5 s is wasteful on a good Wi-Fi and too short on a bad mobile
   * link, so the lead follows the speakers we actually have: the slowest
   * one-way latency plus a safety margin, clamped to a sane range. On a LAN
   * this gives ~0.5 s (playback feels instant); on a slow network it grows
   * automatically instead of starting phones out of step.
   */
  private playLead(sessionId: string, needsDownload: boolean) {
    const ls = this.local.get(sessionId);
    const speakers = ls ? [...ls.speakers.values()] : [];
    const worst = speakers.reduce((a, s) => Math.max(a, s.latencyMs || 0), 0);
    // a phone that has never buffered this track needs time to fetch it
    const base = needsDownload ? 1200 : 350;
    return Math.round(Math.min(SYNC.PLAY_LEAD_MS * 2, Math.max(450, base + worst * 3)));
  }

  async play(sessionId: string, audioId?: string, position?: number) {
    const ls = this.local.get(sessionId); if (!ls) return;
    const t = ls.rec.transport;
    const id = audioId ?? t.trackId ?? t.playlist[0]?.id;
    if (!id) return;
    const idx = t.playlist.findIndex((p) => p.id === id);
    const pos = position ?? (t.trackId === id ? this.serverPosition(sessionId) : 0);
    const ls2 = this.local.get(sessionId);
    const fresh = t.trackId !== id || [...(ls2?.speakers.values() ?? [])].some((s) => s.bufferedSeconds <= 0);
    const startAt = Date.now() + this.playLead(sessionId, fresh);
    await this.mutateTransport(sessionId, {
      state: 'playing', trackId: id, trackIndex: idx, position: pos, positionAtServerTime: startAt,
    });
    await this.fanout(sessionId, { type: 'SYNC_PLAY', audioId: id, position: pos, startAt, volume: t.volume });
  }

  /** Seek/pause need far less head start than a cold start — just the network. */
  private applyLead(sessionId: string) {
    const ls = this.local.get(sessionId);
    const worst = ls ? [...ls.speakers.values()].reduce((a, s) => Math.max(a, s.latencyMs || 0), 0) : 0;
    return Math.round(Math.min(SYNC.APPLY_LEAD_MS, Math.max(120, 80 + worst * 2.5)));
  }

  async pause(sessionId: string) {
    const applyAt = Date.now() + this.applyLead(sessionId);
    const pos = this.serverPosition(sessionId, applyAt);
    await this.mutateTransport(sessionId, { state: 'paused', position: pos, positionAtServerTime: applyAt });
    await this.fanout(sessionId, { type: 'PAUSE', position: pos, applyAt });
  }

  async stop(sessionId: string) {
    await this.mutateTransport(sessionId, { state: 'stopped', position: 0, positionAtServerTime: Date.now() });
    await this.fanout(sessionId, { type: 'STOP' });
  }

  async seek(sessionId: string, position: number) {
    const t = this.transport(sessionId);
    const applyAt = Date.now() + this.applyLead(sessionId);
    const playing = t.state === 'playing';
    await this.mutateTransport(sessionId, { position, positionAtServerTime: applyAt });
    await this.fanout(sessionId, { type: 'SEEK', position, applyAt, playing });
  }

  async setVolume(sessionId: string, volume: number) {
    const v = Math.min(1, Math.max(0, volume));
    await this.mutateTransport(sessionId, { volume: v });
    await this.fanout(sessionId, { type: 'VOLUME', volume: v });
  }

  async resyncAll(sessionId: string) {
    const t = this.transport(sessionId);
    const at = Date.now() + SYNC.APPLY_LEAD_MS;
    // If a scheduled start has not happened yet, resend that exact schedule.
    const pending = t.positionAtServerTime > at;
    await this.fanout(sessionId, {
      type: 'RESYNC',
      position: pending ? t.position : this.serverPosition(sessionId, at),
      atServerTime: pending ? t.positionAtServerTime : at,
      playing: t.state === 'playing',
    }, false);
  }

  async setPlaylist(sessionId: string, tracks: AudioTrack[]) {
    const ls = this.local.get(sessionId); if (!ls) return;
    const t = ls.rec.transport;
    const idx = t.trackId ? tracks.findIndex((x) => x.id === t.trackId) : -1;
    await this.mutateTransport(sessionId, { playlist: tracks, trackIndex: idx });
    await this.fanout(sessionId, { type: 'PLAYLIST', playlist: tracks, trackIndex: idx, autoNext: t.autoNext });
  }

  sessionStateMessage(sessionId: string, you?: { speakerId: string; name: string; group: string; index: number }): ServerMessage | null {
    const ls = this.local.get(sessionId); if (!ls) return null;
    return {
      type: 'SESSION_STATE',
      sessionId,
      sessionName: ls.rec.name,
      hostOnline: ls.hostConns.size > 0,
      speakerCount: ls.speakerConns.size,
      transport: this.reportableTransport(sessionId),
      you,
    };
  }
}
