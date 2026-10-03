/* Optional PWA shell cache. The app works fine WITHOUT installing the PWA. */
const SHELL = 'sync-music-shell-v1';
const AUDIO = 'sync-music-audio-v1';

self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  // never cache control-plane traffic
  if (url.pathname.startsWith('/ws') || url.pathname.startsWith('/api/session')) return;

  if (url.pathname.startsWith('/api/audio/')) {
    // audio is cached by the app itself (Cache API, range-aware fetch)
    return;
  }
  event.respondWith(
    caches.open(SHELL).then(async (cache) => {
      const hit = await cache.match(event.request, { ignoreSearch: true });
      const net = fetch(event.request).then((res) => {
        if (res.ok) cache.put(event.request, res.clone());
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
