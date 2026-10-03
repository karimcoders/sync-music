/**
 * Where is the backend?
 *
 * surge.sh (and any static host) can only serve files — it cannot run the
 * WebSocket gateway, the uploads or Redis. So the speaker page must be able to
 * point at a backend on a different origin.
 *
 * Resolution order:
 *   1. ?api=https://api.example.com  (saved to localStorage, so a shared link
 *      only needs the parameter once)
 *   2. VITE_BACKEND_URL baked in at build time
 *   3. same origin (when the Node server serves the page itself)
 */
const KEY = 'sync-music.backend';

function fromQuery(): string | null {
  const p = new URLSearchParams(location.search).get('api');
  if (!p) return null;
  try {
    const u = new URL(p);
    if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return null;
    const clean = u.origin;
    localStorage.setItem(KEY, clean);
    return clean;
  } catch { return null; }
}

const built = (import.meta.env.VITE_BACKEND_URL ?? '').trim().replace(/\/$/, '');

export const backendOrigin: string =
  fromQuery() ?? localStorage.getItem(KEY) ?? built ?? '';

/** True when the page is hosted separately from the API (e.g. on surge.sh). */
export const isCrossOrigin = !!backendOrigin && backendOrigin !== location.origin;

export function apiUrl(path: string) {
  return `${backendOrigin}${path}`;
}

export function wsUrl() {
  const base = backendOrigin || location.origin;
  return `${base.replace(/^http/, 'ws')}/ws`;
}

/** Audio URLs may come back relative; make them absolute against the backend. */
export function absoluteAudioUrl(url: string) {
  if (!url) return url;
  return /^https?:\/\//i.test(url) ? url : `${backendOrigin}${url}`;
}

export function setBackend(origin: string) {
  localStorage.setItem(KEY, origin.replace(/\/$/, ''));
  location.reload();
}
