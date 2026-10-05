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
  /** `cached` lists tracks this phone already holds, so nothing is re-sent */
  | { type: 'HELLO'; deviceId: string; name?: string; cached?: string[] }
  | { type: 'WELCOME'; speakerId: string; name: string; sessionName: string; hostTime: number }
  // clock sync (T1..T4, identical maths to the WebSocket mode) ------------
  | { type: 'PING'; t1: number }
  | { type: 'PONG'; t1: number; t2: number; t3: number }
  // media ----------------------------------------------------------------
  // The file is sent in paced chunks. One huge send blocks the data channel
  // for seconds, which starves the control messages and makes playback
  // stutter on the phones that are still receiving.
  | { type: 'TRACK_META'; trackId: string; title: string; mime: string; size: number; chunks: number }
  /**
   * "The song is also sitting at this URL." A phone that can reach it
   * downloads from there at full speed instead of waiting for the host's one
   * uplink to send it megabyte by megabyte. Purely an optimisation: a phone
   * that cannot fetch it just waits for the normal transfer.
   */
  | { type: 'TRACK_URL'; trackId: string; title: string; mime: string; url: string }
  | { type: 'TRACK_CHUNK'; trackId: string; index: number; bytes: ArrayBuffer }
  | { type: 'TRACK_READY'; trackId: string }
  /** a speaker noticed holes in the transfer and asks for those chunks again */
  | { type: 'TRACK_NEED'; trackId: string; indexes: number[] }
  /** a speaker was told to play a song it does not hold at all */
  | { type: 'TRACK_WANT'; trackId: string }
  // transport (all timestamps are HOST-clock epoch ms) --------------------
  // Every transport change carries a monotonic `seq`. Speakers report the last
  // one they applied, so the host can tell who missed a command and re-send
  // the full state to exactly that phone — nothing is silently lost any more.
  | { type: 'PLAY'; seq: number; trackId: string; position: number; startAt: number }
  | { type: 'PAUSE'; seq: number; position: number }
  | { type: 'STOP'; seq: number }
  | { type: 'SEEK'; seq: number; trackId: string; position: number; applyAt: number }
  /**
   * Play from YouTube. The audio is NOT carried over this link — it cannot
   * be. Every phone opens the same video itself and is told where to be on
   * the host's clock. See lib/audio/youtube.ts.
   */
  | { type: 'YT'; seq: number; videoId: string | null; position: number; atHostTime: number; playing: boolean }
  | { type: 'RESYNC'; seq: number; trackId: string; position: number; atHostTime: number; playing: boolean }
  | { type: 'VOLUME'; seq: number; volume: number }
  /**
   * The host's channel strip, pushed to every speaker. Without this the mixer
   * was purely local: the person at the host moved bass and nothing anywhere
   * else changed, which is what "the mixer does nothing" meant.
   */
  // NOTE: `rev`, deliberately NOT `seq`. A mixer move is not a transport
  // command: giving it a cmdSeq made every speaker believe it had missed a
  // command, and the host answered each one with a full STATE repair — five
  // slider moves produced twelve repairs.
  | { type: 'MIX'; rev: number; channel: 'music' | 'voice'; settings: Record<string, number | boolean> }
  | { type: 'RENAME'; name: string }
  /**
   * "This is the song that comes next." Not a command (no seq, no timing): it
   * only lets a phone decode the next song in the background so that the
   * switch itself costs nothing. Old speakers simply ignore it.
   */
  | { type: 'NEXT_HINT'; trackId: string | null }
  /** which build of the app the host is running (see the speaker's version warning) */
  | { type: 'BUILD'; build: string }
  /**
   * Damped correction of a speaker's own clock estimate.
   *
   * Over the internet the two directions of a WebRTC channel are often not
   * equally fast (especially through a TURN relay), and an NTP-style exchange
   * then settles on a biased offset — the phone believes it is on time while
   * the host measures it hundreds of ms away. The host owns the only
   * trustworthy measurement, so it hands back half of the error at a time.
   */
  | { type: 'CLOCK_BIAS'; deltaMs: number }
  /** full snapshot used to repair a speaker that fell behind */
  | {
      type: 'STATE'; seq: number; trackId: string | null; title: string; playing: boolean;
      position: number; atHostTime: number; volume: number;
    }
  // telemetry ------------------------------------------------------------
  | {
      type: 'STATUS'; position: number; atHostTime: number; rate: number; playing: boolean;
      buffered: number;
      /** our current clock-sync quality, so the host knows if we are ready */
      clockRtt: number; clockSynced: boolean; clockSamples: number;
      /** last transport seq we applied, and the track we actually hold */
      seq: number; haveTrack: string | null;
      /** everything this phone holds on disk, so the host can skip transfers */
      cached?: string[];
      /** how far our own audio is from where WE think it should be (ms) */
      selfDriftMs: number;
    };

/** Peer ids are namespaced so a random PeerJS id can never collide with ours. */
export const PEER_PREFIX = 'syncmusic-';

/**
 * ONE permanent room.
 *
 * Everybody — the host and every speaker — uses the same link, so it can be
 * printed on a QR code once and reused forever; nothing has to be typed and no
 * new URL is generated per session. The trade-off is honest and worth stating:
 * this id is public, so anyone who opens the link joins your room, and only one
 * host at a time can hold it.
 */
export const FIXED_ROOM_ID = `${PEER_PREFIX}main`;

/**
 * The shared broker keeps an id reserved for a while after a host tab closes,
 * and the id is public, so the one name can be temporarily unusable. The room
 * is therefore a short ORDERED LIST of slots: the host takes the first free
 * one and a speaker simply tries them in the same order until one answers.
 * The link the user shares never changes.
 */
export const ROOM_SLOTS = [FIXED_ROOM_ID, ...Array.from({ length: 3 }, (_, i) => `${FIXED_ROOM_ID}-${i + 2}`)];

/** Human-typeable code (no 0/O/1/I), also used as the PeerJS room id. */
export function newRoomCode(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => alphabet[b % alphabet.length]).join('');
}
export const roomIdFromCode = (code: string) => PEER_PREFIX + code.trim().toLowerCase();
export const codeFromRoomId = (id: string) => id.replace(PEER_PREFIX, '');

/**
 * Public, free, account-less PeerJS broker. It only introduces the two
 * browsers; audio and control messages go peer to peer.
 *
 * STUN alone is not enough in practice: two phones on mobile data sit behind
 * carrier-grade NAT, which usually blocks a direct path, and the connection
 * silently never opens. The free OpenRelay TURN servers relay the traffic in
 * that case — slower, but it actually connects. They are public credentials
 * published by metered.ca for exactly this purpose (no secret of ours is
 * exposed here).
 */
/**
 * Signalling brokers, tried in order.
 *
 * WebRTC needs a rendezvous server before two phones can find each other, and
 * a single public one is a single point of failure: it rate-limits, it goes
 * down, and it keeps ids reserved. Both sides walk the same list, so they meet
 * on whichever one is healthy.
 */
export const BROKERS: Array<Record<string, unknown>> = [
  {},                                                                   // 0.peerjs.com (PeerJS cloud)
  // NB: PeerJS appends "peerjs" to `path`, so the path here is "/" even
  // though the endpoint is /peerjs.
  { host: 'peerjs-server.onrender.com', secure: true, port: 443, path: '/', key: 'peerjs' },
];

/** Full PeerJS options for broker `i` (ICE config is always the same). */
export function peerOptions(i = 0) {
  return { ...PEER_OPTIONS, ...BROKERS[i % BROKERS.length] };
}

export const PEER_OPTIONS = {
  debug: 0 as const,
  config: {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:global.stun.twilio.com:3478'] },
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    ],
    iceCandidatePoolSize: 4,
  },
};
