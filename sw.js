/*
 * CastLeague service worker — lets the browser build open with no signal.
 *
 * Without this, closing the tab at the water (or Android reclaiming it) meant
 * the app could not be reopened until the phone had signal again. Logging was
 * already offline-safe — drafts live in IndexedDB and upload when signal
 * returns — but the app itself was not stored on the phone.
 *
 * Three rules, nothing clever:
 *
 *  1. Pages (navigations): network first, so a phone with signal always gets
 *     the newest build; fall back to the stored index.html when offline. The
 *     app is a single-page app, so that one document serves every route.
 *  2. The app's own files (hashed JS bundles, icons, fonts): served from the
 *     store when present, fetched and stored otherwise. Hashed names never
 *     change content, so this cannot serve stale code.
 *  3. Map tiles, glyphs, sprites and style from MapTiler: stored as they are
 *     viewed, served from the store when offline. So the map works at the water
 *     for any area the angler looked at with signal. Capped so it cannot fill
 *     the phone.
 *
 * Supabase (data, sign-in, uploads) is NEVER intercepted. The app has its own
 * offline cache for data and its own queue for uploads; caching API responses
 * here would show people stale or someone else's data.
 */

const VERSION = 'v1';
const SHELL = `castleague-shell-${VERSION}`;
const MAPS = `castleague-maps-${VERSION}`;
const MAX_MAP_ENTRIES = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // The page plus whatever bundle it currently points at, so the very first
      // offline open works even if the angler never navigated anywhere else.
      try {
        const response = await fetch('/', { cache: 'no-store' });
        if (response.ok) {
          const html = await response.clone().text();
          await cache.put('/index.html', response);
          const assets = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)]
            .map((match) => match[1])
            .filter((path) => !path.startsWith('//'));
          await Promise.all(
            [...new Set(['/manifest.json', '/favicon.png', ...assets])].map((path) =>
              cache.add(path).catch(() => undefined),
            ),
          );
        }
      } catch {
        // Installing offline: nothing to store yet, the next online visit will.
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL, MAPS]);
      for (const key of await caches.keys()) {
        if (key.startsWith('castleague-') && !keep.has(key)) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

function isMapRequest(url) {
  return url.hostname === 'api.maptiler.com' || url.hostname.endsWith('.maptiler.com');
}

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i += 1) await cache.delete(keys[i]);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // 1. Pages.
  if (request.mode === 'navigate' && url.origin === self.location.origin) {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          if (fresh.ok) {
            const cache = await caches.open(SHELL);
            await cache.put('/index.html', fresh.clone());
          }
          return fresh;
        } catch {
          const cached = await caches.match('/index.html');
          return cached ?? Response.error();
        }
      })(),
    );
    return;
  }

  // 2. The app's own files.
  if (url.origin === self.location.origin) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(SHELL);
          await cache.put(request, response.clone());
        }
        return response;
      })(),
    );
    return;
  }

  // 3. Map tiles and their style, fonts and sprites.
  if (isMapRequest(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(MAPS);
        const cached = await cache.match(request);
        if (cached) {
          // Refresh in the background when there is signal; never block on it.
          event.waitUntil(
            fetch(request)
              .then((fresh) => (fresh.ok ? cache.put(request, fresh) : undefined))
              .catch(() => undefined),
          );
          return cached;
        }
        try {
          const response = await fetch(request);
          if (response.ok) {
            await cache.put(request, response.clone());
            event.waitUntil(trim(MAPS, MAX_MAP_ENTRIES));
          }
          return response;
        } catch {
          return Response.error();
        }
      })(),
    );
  }
  // Everything else (Supabase, analytics) goes straight to the network.
});
