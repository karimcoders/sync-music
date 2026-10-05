import { HostClient } from '../hostClient';
import { P2PHostClient } from './p2pHost';
import type { Mode } from '../mode';

/**
 * The host (the room itself) lives here, not inside the Host page.
 *
 * The page used to dispose the host when it unmounted, and disposing destroys
 * the peer. So the moment the host tapped MIXER, SPEAKER or SOUND on the tab
 * bar the room vanished and every phone dropped out of it. Pages now only
 * WATCH the host; the room stays open until shutdownHost() (sign out).
 */
export type AnyHost = HostClient | P2PHostClient;

let host: AnyHost | null = null;
let hostMode: Mode | null = null;

export function getHost(): AnyHost | null { return host; }

export function acquireHost(mode: Mode, listener: (s: any) => void) {
  let fresh = false;
  if (!host || hostMode !== mode) {
    try { host?.dispose(); } catch { /* replaced */ }
    host = mode === 'direct' ? new P2PHostClient(() => {}) : new HostClient(() => {});
    hostMode = mode;
    fresh = true;
  }
  const client = host;
  const release = (client as any).subscribe(listener) as () => void;
  return { client, fresh, release };
}

export function shutdownHost() {
  try { host?.dispose(); } catch { /* already gone */ }
  host = null;
  hostMode = null;
}
