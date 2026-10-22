// Service Worker: immer zuerst das Netz fragen (neue Karten sofort sichtbar),
// bei fehlender Verbindung die zuletzt geladene Version aus dem Cache liefern.
const CACHE = 'karteikarten-v2';

// Ist schon eine ältere Version aktiv, handelt es sich um ein Update
let isUpdate = false;
self.addEventListener('install', () => {
  isUpdate = !!self.registration.active;
  self.skipWaiting();
});

// Nach einem Update offene Fenster neu laden, damit die neue Version sofort sichtbar ist
// (nicht mitten in einer Lernrunde)
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
  await self.clients.claim();
  if (!isUpdate) return;
  const windows = await self.clients.matchAll({ type: 'window' });
  windows.filter((w) => !new URL(w.url).hash.startsWith('#/lernen/')).forEach((w) => w.navigate(w.url));
})()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  const cacheable = req.method === 'GET'
    && (url.origin === self.location.origin || url.hostname === 'cdnjs.cloudflare.com');
  if (!cacheable) return; // z. B. Sync mit api.github.com nie cachen
  // cache: 'no-cache' fragt immer beim Server nach (GitHub Pages erlaubt sonst 10 Min. Browser-Cache)
  e.respondWith(
    fetch(req, { cache: 'no-cache' })
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
