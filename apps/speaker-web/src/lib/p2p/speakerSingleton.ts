import { SpeakerClient, type UiState } from '../client';
import { P2PSpeakerClient } from './p2pSpeaker';

/**
 * The speaker client that is running in this tab.
 *
 * It lives HERE, not inside the Speaker page. The page used to create the
 * client when it mounted and disconnect it when it unmounted, so tapping the
 * MIXER tab (or HOME) tore the connection and the whole audio graph down:
 * the mixer then had nothing to act on, and the phone dropped out of the room
 * every time somebody touched a tab. Pages now only WATCH this client; it keeps
 * playing while you move between screens and stops only on leaveSpeaker().
 */
export type AnySpeaker = SpeakerClient | P2PSpeakerClient;

let current: AnySpeaker | null = null;
let currentKey: string | null = null;

/** the direct-mode client, which is the one that owns a Web Audio graph to mix */
export function getSpeaker(): P2PSpeakerClient | null {
  return current instanceof P2PSpeakerClient ? current : null;
}

export function getAnySpeaker(): AnySpeaker | null { return current; }

/**
 * Get the running client for this room, or start one. `fresh` tells the
 * caller whether it was just created (and therefore still needs connecting).
 * `release` only stops WATCHING — it never disconnects.
 */
export function acquireSpeaker(room: string | null, listener: (s: UiState) => void) {
  const key = room ?? '#server';
  let fresh = false;
  if (!current || currentKey !== key) {
    try { current?.disconnect(); } catch { /* the old one is going away anyway */ }
    current = room ? new P2PSpeakerClient(room, () => {}) : new SpeakerClient(() => {});
    currentKey = key;
    fresh = true;
  }
  const client = current;
  const release = client.subscribe(listener);
  return { client, fresh, release };
}

/** Really leave: stop playing, close the connection, free the audio graph. */
export function leaveSpeaker() {
  try { current?.disconnect(); } catch { /* already gone */ }
  current = null;
  currentKey = null;
}
