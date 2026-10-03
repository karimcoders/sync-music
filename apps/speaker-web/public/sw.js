/* Optional PWA shell cache. The app works fine WITHOUT installing the PWA.
 *
 * IMPORTANT: this used to be cache-first for everything, which meant a phone
 * kept running an old build for days — updates simply never arrived. HTML and
 * anything unhashed is now network-first; only Vite's content-hashed assets
 * (which can never go stale, their name changes) are served from cache.
 */
const SHELL = 'sync-music-shell-v3';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== SHELL) await caches.delete(k);
  await self.clients.claim();
})()));

const HASHED = /\/assets\/.+-[A-Za-z0-9_-]{8,}\.(js|css|woff2?|png|svg)$/;

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/api/') || url.pathname.startsWith('/ws')) return;

  if (HASHED.test(url.pathname)) {
    event.respondWith(caches.open(SHELL).then(async (cache) => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    }));
    return;
  }

  // everything else (index.html, sw-less navigations, the manifest): fresh
  // first, cache only as an offline fallback
  event.respondWith((async () => {
    try {
      const res = await fetch(req, { cache: 'no-store' });
      if (res.ok) (await caches.open(SHELL)).put(req, res.clone());
      return res;
    } catch {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw new Error('offline');
    }
  })());
});
