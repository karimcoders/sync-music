import type { P2PSpeakerClient } from './p2pSpeaker';

/**
 * The speaker client that is currently running in this tab.
 *
 * The mixer is a separate screen but must act on the live audio graph — a
 * slider that only takes effect after a reload is not a mixer. The speaker
 * page registers itself here when it starts and clears it when it stops.
 */
let current: P2PSpeakerClient | null = null;

export function setSpeaker(c: P2PSpeakerClient | null) { current = c; }
export function getSpeaker(): P2PSpeakerClient | null { return current; }
