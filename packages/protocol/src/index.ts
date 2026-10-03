/**
 * @sync-music/protocol
 * Single source of truth for the WebSocket + REST contract shared by
 * the Node server, the React speaker client and (mirrored manually) the
 * Kotlin host app.
 *
 * Design rules:
 *  - Every playback command carries an absolute SERVER timestamp (epoch ms).
 *    Clients never act "now", they act "at startAt / applyAt".
 *  - Payloads are tiny: broadcasting to N speakers must stay cheap.
 *  - There is NO product-level maximum speaker count anywhere in this file.
 *    The only cap that exists is an infrastructure guard on the server
 *    (MAX_CONNECTIONS_PER_INSTANCE) which is a capacity signal, not a limit
 *    of the product.
 */

export const PROTOCOL_VERSION = 3;

/* ------------------------------------------------------------------ */
/* Domain models                                                       */
/* ------------------------------------------------------------------ */

export type SessionStatus = 'active' | 'ended';
export type SpeakerStatus = 'connected' | 'reconnecting' | 'disconnected';
export type PlaybackState = 'idle' | 'playing' | 'paused' | 'stopped';

export interface AudioTrack {
  id: string;
  title: string;
  artist: string;
  filename: string;
  mimeType: string;
  size: number;
  /** seconds; 0 when unknown (client reports real duration after load) */
  duration: number;
  /** signed, short-lived URL the speakers fetch (CDN/object storage in prod) */
  url: string;
  createdAt: number;
}

export interface SpeakerInfo {
  id: string;
  name: string;
  group: string;
  status: SpeakerStatus;
  muted: boolean;
  /** one-way network latency estimate in ms, from clock sync */
  latencyMs: number;
  /** signed drift vs. the authoritative server position, in ms */
  driftMs: number;
  state: PlaybackState;
  bufferedSeconds: number;
  joinedAt: number;
  lastSeen: number;
}

export interface SessionPublic {
  sessionId: string;
  /** human label shown in the speaker discovery list, e.g. "Karim's Music" */
  name: string;
  speakerCount: number;
  hostOnline: boolean;
  createdAt: number;
}

/** Authoritative transport state of a session. */
export interface TransportState {
  state: PlaybackState;
  trackId: string | null;
  /** position (s) that was true at `positionAtServerTime` */
  position: number;
  positionAtServerTime: number;
  /** master software volume applied by every speaker, 0..1 */
  volume: number;
  playlist: AudioTrack[];
  trackIndex: number;
  autoNext: boolean;
}

/* ------------------------------------------------------------------ */
/* Server -> client messages                                           */
/* ------------------------------------------------------------------ */

export type ServerMessage =
  | { type: 'HELLO'; protocolVersion: number; serverTime: number; connectionId: string }
  | {
      type: 'SESSION_STATE';
      sessionId: string;
      sessionName: string;
      hostOnline: boolean;
      /** dynamic — never a fraction of a fixed maximum */
      speakerCount: number;
      transport: TransportState;
      /** identity assigned to THIS speaker (absent for the host socket) */
      you?: { speakerId: string; name: string; group: string; index: number };
    }
  | { type: 'SYNC_PLAY'; audioId: string; position: number; startAt: number; volume: number }
  | { type: 'PAUSE'; position: number; applyAt: number }
  | { type: 'STOP' }
  | { type: 'SEEK'; position: number; applyAt: number; playing: boolean }
  | { type: 'VOLUME'; volume: number }
  | { type: 'MUTE'; muted: boolean }
  | { type: 'TRACK_CHANGED'; audioId: string; position: number }
  | { type: 'RESYNC'; position: number; atServerTime: number; playing: boolean }
  | { type: 'SYNC_REQUEST' }
  | { type: 'CLOCK_SYNC_REPLY'; clientTime: number; serverReceiveTime: number; serverSendTime: number }
  | { type: 'HOST_DISCONNECTED' }
  | { type: 'HOST_CONNECTED' }
  | { type: 'SESSION_ENDED'; reason: string }
  | { type: 'RENAMED'; name: string; group: string }
  /** server-side aggregation: only the host ever receives speaker telemetry */
  | {
      type: 'SPEAKERS_SNAPSHOT';
      speakerCount: number;
      averageDriftMs: number;
      averageLatencyMs: number;
      speakers: SpeakerInfo[];
      /** true when the list was truncated for very large sessions */
      truncated: boolean;
    }
  | { type: 'PLAYLIST'; playlist: AudioTrack[]; trackIndex: number; autoNext: boolean }
  | { type: 'ERROR'; code: ErrorCode; message: string };

export type ErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'SESSION_ENDED'
  | 'UNAUTHORIZED'
  | 'SERVER_AT_CAPACITY'
  | 'RATE_LIMITED'
  | 'BAD_REQUEST'
  | 'AUDIO_NOT_FOUND';

/* ------------------------------------------------------------------ */
/* Client -> server messages                                           */
/* ------------------------------------------------------------------ */

export type ClientMessage =
  | { type: 'SPEAKER_JOIN'; sessionId: string; deviceId: string; speakerToken?: string; name?: string }
  | { type: 'HOST_JOIN'; sessionId: string; hostToken: string }
  | { type: 'SPEAKER_READY'; audioId?: string }
  | { type: 'PLAYBACK_STATUS'; position: number; state: PlaybackState; buffered: number }
  | { type: 'CLOCK_SYNC'; clientTime: number }
  | { type: 'PING' }
  /* host-only control messages */
  | { type: 'HOST_PLAY'; audioId?: string; position?: number }
  | { type: 'HOST_PAUSE' }
  | { type: 'HOST_STOP' }
  | { type: 'HOST_SEEK'; position: number }
  | { type: 'HOST_NEXT' }
  | { type: 'HOST_PREV' }
  | { type: 'HOST_VOLUME'; volume: number }
  | { type: 'HOST_RESYNC_ALL' }
  | { type: 'HOST_MUTE_GROUP'; group: string; muted: boolean }
  | { type: 'HOST_RENAME_SPEAKER'; speakerId: string; name?: string; group?: string }
  | { type: 'HOST_SET_PLAYLIST'; trackIds: string[] }
  | { type: 'HOST_AUTO_NEXT'; enabled: boolean };

/* ------------------------------------------------------------------ */
/* Tunables (behaviour, not capacity)                                  */
/* ------------------------------------------------------------------ */

export const SYNC = {
  /** how far in the future a SYNC_PLAY is scheduled */
  PLAY_LEAD_MS: 1500,
  /** how far in the future a SEEK/PAUSE is scheduled */
  APPLY_LEAD_MS: 400,
  /** |drift| below this: do nothing */
  DRIFT_IGNORE_MS: 50,
  /** |drift| in [IGNORE, HARD): correct smoothly with playbackRate */
  DRIFT_HARD_MS: 150,
  /** playbackRate nudge applied during soft correction */
  RATE_NUDGE: 0.01,
  /** clock sync probes */
  CLOCK_BURST: 5,
  CLOCK_BURST_INTERVAL_MS: 120,
  CLOCK_REFRESH_MS: 15000,
  HEARTBEAT_MS: 10000,
} as const;

/**
 * Telemetry back-off: the more speakers in a session, the less often each one
 * reports. Keeps server ingress ~linear-but-flat instead of exploding.
 */
export function statusIntervalMs(speakerCount: number): number {
  if (speakerCount <= 10) return 2000;
  if (speakerCount <= 50) return 3500;
  if (speakerCount <= 200) return 6000;
  if (speakerCount <= 1000) return 12000;
  return 20000;
}

export function safeParse<T = ClientMessage | ServerMessage>(raw: string): T | null {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && typeof v.type === 'string') return v as T;
    return null;
  } catch {
    return null;
  }
}
