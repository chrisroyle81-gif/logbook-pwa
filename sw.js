// Logbook service worker - app-shell cache.
// Bump CACHE when you change shell files so clients re-download.
//
// v5 - adds a font cache. index.html now loads JetBrains Mono from Google
//      Fonts (before, the font-family named it but nothing ever fetched it,
//      so the app silently fell back to the device monospace). Fonts are
//      cross-origin, and the old fetch handler returned early for anything
//      not same-origin, so they would never have been available offline.
//      Cached stale-while-revalidate in a separate bucket that survives
//      shell-cache version bumps.
const CACHE = 'logbook-v5';
const FONT_CACHE = 'logbook-fonts-v1';
const SHELL = ['./', './index.html', './manifest.json'];

const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          // Keep the font bucket across shell bumps - the font has not changed
          // just because index.html did.
          .filter(k => k !== CACHE && k !== FONT_CACHE)
          .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Google Fonts: serve from cache immediately, refresh in the background.
  if (FONT_HOSTS.indexOf(url.hostname) >= 0) {
    e.respondWith(
      caches.open(FONT_CACHE).then(cache =>
        cache.match(e.request).then(cached => {
          const network = fetch(e.request).then(res => {
            if (res && res.ok) cache.put(e.request, res.clone()).catch(() => {});
            return res;
          }).catch(() => cached);
          return cached || network;
        })
      )
    );
    return;
  }

  if (url.origin !== location.origin) return;

  // Network-first for the HTML shell so updates roll out without a manual wipe.
  if (e.request.mode === 'navigate' || url.pathname.endsWith('/index.html')) {
    e.respondWith(
      fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
