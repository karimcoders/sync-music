import type { WebSocket } from 'ws';
import { ClientMessage, safeParse, SYNC } from '@sync-music/protocol';
import { SessionHub, type Conn } from './sessions';
import { config } from './config';
import { log } from './logger';
import { randomId, signAudioPath, signToken, verifyToken } from './security';
import { audioStore, publicAudioUrl } from './storage';
import type { AudioTrack } from '@sync-music/protocol';

/** Build playlist entries with freshly signed, short-lived audio URLs. */
export function resolveTracks(ids: string[]): AudioTrack[] {
  const out: AudioTrack[] = [];
  for (const id of ids.slice(0, 500)) {
    const m = audioStore.get(id);
    if (!m) continue;
    out.push({ ...m, url: publicAudioUrl(signAudioPath(id), config.publicBaseUrl) });
  }
  return out;
}

/** Per-connection token bucket. Protects the gateway at any speaker count. */
const BUDGET_MAX = 60;       // messages
const BUDGET_REFILL_MS = 1000;

export function attachSocket(hub: SessionHub, ws: WebSocket) {
  const conn: Conn = {
    id: randomId(8), ws, role: 'anon', sessionId: null, speakerId: null,
    alive: true, lastMsg: Date.now(), msgBudget: BUDGET_MAX,
  };

  if (hub.atCapacity()) {
    // Infrastructure capacity — NOT a product limit. Existing speakers untouched.
    try {
      ws.send(JSON.stringify({
        type: 'ERROR', code: 'SERVER_AT_CAPACITY',
        message: 'Server is currently at capacity. Please try again later.',
      }));
    } catch {}
    ws.close(1013, 'at capacity');
    return;
  }

  hub.registerConnection(conn);
  hub.send(conn, { type: 'HELLO', protocolVersion: 3, serverTime: Date.now(), connectionId: conn.id });

  const refill = setInterval(() => { conn.msgBudget = BUDGET_MAX; }, BUDGET_REFILL_MS);
  refill.unref?.();

  const heartbeat = setInterval(() => {
    if (!conn.alive) { try { ws.terminate(); } catch {} return; }
    conn.alive = false;
    try { ws.ping(); } catch {}
  }, SYNC.HEARTBEAT_MS);
  heartbeat.unref?.();

  ws.on('pong', () => { conn.alive = true; });

  ws.on('message', (data) => {
    conn.alive = true;
    if (conn.msgBudget-- <= 0) {
      hub.send(conn, { type: 'ERROR', code: 'RATE_LIMITED', message: 'Too many messages.' });
      return;
    }
    const msg = safeParse<ClientMessage>(String(data));
    if (!msg) return;
    handle(hub, conn, msg).catch((e) => {
      log.error('ws handler error', e);
      hub.send(conn, { type: 'ERROR', code: 'BAD_REQUEST', message: 'Something went wrong. Retrying…' });
    });
  });

  const cleanup = () => {
    clearInterval(heartbeat);
    clearInterval(refill);
    void hub.detach(conn);
  };
  ws.on('close', cleanup);
  ws.on('error', (e) => { log.error('ws error', (e as Error).message); });
}

async function handle(hub: SessionHub, conn: Conn, msg: ClientMessage) {
  switch (msg.type) {
    /* ---------------- clock sync (NTP-style, 4 timestamps) -------------- */
    case 'CLOCK_SYNC': {
      const serverReceiveTime = Date.now();
      hub.send(conn, {
        type: 'CLOCK_SYNC_REPLY',
        clientTime: msg.clientTime,
        serverReceiveTime,
        serverSendTime: Date.now(),
      });
      return;
    }
    case 'PING': return;

    /* ------------------------------ join -------------------------------- */
    case 'SPEAKER_JOIN': {
      const prev = verifyToken<{ sid: string; spk: string }>(msg.speakerToken);
      const known = prev && prev.sid === msg.sessionId ? prev.spk : null;
      const res = await hub.attachSpeaker(conn, msg.sessionId, msg.deviceId, known);
      if (res === 'CAPACITY') {
        hub.send(conn, { type: 'ERROR', code: 'SERVER_AT_CAPACITY', message: 'Server is currently at capacity. Please try again later.' });
        return;
      }
      if (!res) {
        hub.send(conn, { type: 'ERROR', code: 'SESSION_NOT_FOUND', message: 'Host session ended.' });
        return;
      }
      const state = hub.sessionStateMessage(msg.sessionId, {
        speakerId: res.rec.id, name: res.rec.name, group: res.rec.group, index: res.index,
      });
      if (state) hub.send(conn, state);
      // identity token lets the SAME phone reclaim its speaker slot after a drop
      hub.send(conn, {
        type: 'RENAMED', name: res.rec.name, group: res.rec.group,
      });
      conn.ws.send(JSON.stringify({
        type: 'HELLO', protocolVersion: 3, serverTime: Date.now(),
        connectionId: signToken({ sid: msg.sessionId, spk: res.rec.id }, config.sessionTtlMs),
      }));
      return;
    }

    case 'HOST_JOIN': {
      const t = verifyToken<{ sid: string; role: string }>(msg.hostToken);
      if (!t || t.role !== 'host' || t.sid !== msg.sessionId) {
        hub.send(conn, { type: 'ERROR', code: 'UNAUTHORIZED', message: 'Host authentication failed.' });
        conn.ws.close(4401, 'unauthorized');
        return;
      }
      const ls = await hub.attachHost(conn, msg.sessionId);
      if (!ls) {
        hub.send(conn, { type: 'ERROR', code: 'SESSION_NOT_FOUND', message: 'Session no longer exists.' });
        return;
      }
      const state = hub.sessionStateMessage(msg.sessionId);
      if (state) hub.send(conn, state);
      await hub.sendHostSnapshot(msg.sessionId);
      return;
    }

    /* --------------------------- speaker telemetry ---------------------- */
    case 'SPEAKER_READY': {
      if (!conn.sessionId) return;
      hub.scheduleHostSnapshot(conn.sessionId, 300);
      // A speaker asks for this whenever it lacks the current track (just
      // enabled audio, playlist changed, track changed, reconnected…).
      // Answer with the authoritative state so it can load and catch up.
      const st = hub.sessionStateMessage(conn.sessionId);
      if (st) hub.send(conn, st);
      return;
    }
    case 'PLAYBACK_STATUS': {
      hub.reportStatus(conn, msg.position, msg.state, msg.buffered);
      return;
    }
  }

  /* ------------------------------ host only ----------------------------- */
  if (conn.role !== 'host' || !conn.sessionId) {
    hub.send(conn, { type: 'ERROR', code: 'UNAUTHORIZED', message: 'Only the host can control playback.' });
    return;
  }
  const sid = conn.sessionId;
  switch (msg.type) {
    case 'HOST_PLAY': await hub.play(sid, msg.audioId, msg.position); break;
    case 'HOST_PAUSE': await hub.pause(sid); break;
    case 'HOST_STOP': await hub.stop(sid); break;
    case 'HOST_SEEK': await hub.seek(sid, msg.position); break;
    case 'HOST_NEXT': await hub.advance(sid, +1, true); break;
    case 'HOST_PREV': await hub.advance(sid, -1, true); break;
    case 'HOST_VOLUME': await hub.setVolume(sid, msg.volume); break;
    case 'HOST_RESYNC_ALL': await hub.resyncAll(sid); break;
    case 'HOST_MUTE_GROUP': hub.muteGroup(sid, msg.group, msg.muted); break;
    case 'HOST_RENAME_SPEAKER': hub.renameSpeaker(sid, msg.speakerId, msg.name, msg.group); break;
    case 'HOST_AUTO_NEXT': await hub.mutateTransport(sid, { autoNext: msg.enabled }); break;
    case 'HOST_SET_PLAYLIST': await hub.setPlaylist(sid, resolveTracks(msg.trackIds)); break;
    default: break;
  }
  const st = hub.sessionStateMessage(sid);
  if (st) hub.send(conn, st);
}
