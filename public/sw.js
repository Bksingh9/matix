/* MindSharp service worker.
 *
 * Two rules, and the second one is the important one:
 *
 *  1. The app shell is cached so the game is fully playable offline. That is
 *     not a nicety here — a mental-maths game is exactly what people open on a
 *     train, and a streak that breaks because of a tunnel is a lost player.
 *
 *  2. /api/* is NEVER cached. A cached /api/me would mean a stale entitlement:
 *     a cancelled subscriber keeping Pro, or a fresh purchase not appearing.
 *     Entitlement is server-authoritative, and a cache is a second opinion.
 */

const VERSION = 'v10';
const SHELL = `mindsharp-shell-${VERSION}`;
const RUNTIME = `mindsharp-runtime-${VERSION}`;

/* Everything needed to boot and play a round with no network at all. */
const SHELL_URLS = [
  '/',
  '/index.html',
  '/css/app.css',
  '/favicon.svg',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/js/main.js',
  '/js/config.js',
  '/js/util.js',
  '/js/store.js',
  '/js/state.js',
  '/js/audio.js',
  '/js/games.js',
  '/js/ui.js',
  '/js/engine.js',
  '/js/paywall.js',
  '/js/analytics.js',
  '/js/api.js',
  '/js/auth.js',
  '/js/entitlement.js',
  '/js/account.js',
  '/js/drills.js',
  '/js/runlog.js',
  '/js/progress.js',
  '/js/progression.js',
  '/js/social.js',
  '/js/install.js',
  '/js/native.js',
  '/js/notify.js'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // Individually, not addAll: one 404 must not abandon the whole install and
    // leave the app with no offline support at all.
    await Promise.all(SHELL_URLS.map(async url => {
      try { await cache.add(new Request(url, { cache: 'reload' })); }
      catch (e) { console.warn('[sw] could not precache', url); }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k.startsWith('mindsharp-') && k !== SHELL && k !== RUNTIME)
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // fonts, CDN, Supabase

  // Never cache the API. Entitlement, progression and leaderboards are all
  // server-authoritative and a stale answer is worse than no answer.
  if (url.pathname.startsWith('/api/')) return;

  // Navigations: try the network so a deploy is picked up, fall back to the
  // cached shell so the game opens on a plane.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(SHELL);
        cache.put('/index.html', fresh.clone());
        return fresh;
      } catch {
        return (await caches.match('/index.html')) || (await caches.match('/')) || Response.error();
      }
    })());
    return;
  }

  // Static assets: serve from cache immediately, refresh in the background.
  // The game has to start instantly; a version behind for one load is fine,
  // and the next load has the new one.
  event.respondWith((async () => {
    const cached = await caches.match(req);
    const network = fetch(req).then(async res => {
      if (res && res.ok && res.type === 'basic') {
        const cache = await caches.open(RUNTIME);
        cache.put(req, res.clone());
      }
      return res;
    }).catch(() => null);

    if (cached) { event.waitUntil(network); return cached; }
    const fresh = await network;
    return fresh || new Response('', { status: 504, statusText: 'offline' });
  })());
});
