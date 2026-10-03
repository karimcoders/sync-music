import { backendOrigin } from './backend';

export type Mode = 'server' | 'direct';

function param(name: string): string | null {
  const hashQuery = location.hash.includes('?') ? location.hash.slice(location.hash.indexOf('?') + 1) : '';
  return new URLSearchParams(location.search).get(name) ?? new URLSearchParams(hashQuery).get(name);
}

/** Room id of a direct-mode host, when the link carries one. */
export function roomParam(): string | null {
  const h = param('h');
  return h && /^[a-z0-9-]{4,64}$/i.test(h) ? h : null;
}

/**
 * Which engine should this page use?
 *
 *   server  — a Sync Music backend is reachable (same origin, or ?api=…).
 *             Audio is uploaded once and served to every phone from the server.
 *   direct  — no backend at all. The host tab becomes the authority and the
 *             phones connect to it over WebRTC. This is what makes the static
 *             GitHub Pages deployment work on its own.
 *
 * Explicit override: ?mode=direct or ?mode=server.
 */
export async function detectMode(timeoutMs = 2500): Promise<Mode> {
  const forced = param('mode');
  if (forced === 'direct' || forced === 'server') return forced;
  if (roomParam()) return 'direct';

  const origin = backendOrigin || location.origin;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetch(`${origin}/healthz`, { signal: ctl.signal });
    clearTimeout(t);
    if (r.ok) return 'server';
  } catch { /* no backend there */ }
  return 'direct';
}
