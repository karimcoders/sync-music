/**
 * Direct (serverless) mode — wire format.
 *
 * In this mode there is no backend at all: the HOST browser is the authority.
 * Phones connect to it with WebRTC data channels (PeerJS), and the *host clock*
 * plays the role the server clock plays in the normal mode. Everything else —
 * NTP-style offset estimation, scheduled start timestamps, the drift policy —
 * is the exact same logic from @sync-music/sync-engine.
 *
 * Honest limits of this mode (see README):
 *   • the host tab must stay open; it is the server,
 *   • each phone downloads the track from the host over WebRTC,
 *   • one extra hop (host → phone) instead of a CDN, so first start is slower.
 */

export type P2PMessage =
  // handshake ------------------------------------------------------------
  | { type: 'HELLO'; deviceId: string; name?: string }
  | { type: 'WELCOME'; speakerId: string; name: string; sessionName: string; hostTime: number }
  // clock sync (T1..T4, identical maths to the WebSocket mode) ------------
  | { type: 'PING'; t1: number }
  | { type: 'PONG'; t1: number; t2: number; t3: number }
  // media ----------------------------------------------------------------
  | { type: 'TRACK'; trackId: string; title: string; mime: string; bytes: ArrayBuffer }
  | { type: 'TRACK_READY'; trackId: string }
  // transport (all timestamps are HOST-clock epoch ms) --------------------
  | { type: 'PLAY'; trackId: string; position: number; startAt: number }
  | { type: 'PAUSE'; position: number }
  | { type: 'STOP' }
  | { type: 'SEEK'; trackId: string; position: number; applyAt: number }
  | { type: 'RESYNC'; trackId: string; position: number; atHostTime: number; playing: boolean }
  | { type: 'VOLUME'; volume: number }
  | { type: 'RENAME'; name: string }
  // telemetry ------------------------------------------------------------
  | { type: 'STATUS'; position: number; atHostTime: number; rate: number; playing: boolean; buffered: number };

/** Peer ids are namespaced so a random PeerJS id can never collide with ours. */
export const PEER_PREFIX = 'syncmusic-';

/** Human-typeable code (no 0/O/1/I), also used as the PeerJS room id. */
export function newRoomCode(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => alphabet[b % alphabet.length]).join('');
}
export const roomIdFromCode = (code: string) => PEER_PREFIX + code.trim().toLowerCase();
export const codeFromRoomId = (id: string) => id.replace(PEER_PREFIX, '');

/** Public, free, account-less PeerJS broker. It only brokers the connection. */
export const PEER_OPTIONS = { debug: 0 as const };
