// Service Worker: immer zuerst das Netz fragen (neue Karten sofort sichtbar),
// bei fehlender Verbindung die zuletzt geladene Version aus dem Cache liefern.
const CACHE = 'karteikarten-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  const cacheable = req.method === 'GET'
    && (url.origin === self.location.origin || url.hostname === 'cdnjs.cloudflare.com');
  if (!cacheable) return; // z. B. Sync mit api.github.com nie cachen
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || Promise.reject(new Error('offline'))))
  );
});
