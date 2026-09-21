/// <reference lib="webworker" />

// Indexstr — self-destructing service worker (kill switch).
//
// A previous version of this worker precached index.html and served hashed JS
// cache-first with no invalidation. That pinned browsers to a stale bundle
// (main-RIUOZXF3.js) and resurfaced a fixed "Card is not defined" error on
// every load, no matter how many times the project was rebuilt.
//
// Recovery cannot live in the app bundle — if the stale bundle is being served,
// that code never runs. The browser DOES re-fetch /sw.js independently of the
// page, so this file is the only reliable escape hatch.
//
// This worker therefore:
//   1. claims all clients immediately,
//   2. deletes every Cache Storage entry for this origin,
//   3. unregisters itself,
//   4. force-reloads open pages so they fetch fresh HTML + JS from the network.
//
// After this has run once, no service worker controls the origin and everything
// is served straight from the network. Do not reintroduce HTML caching here.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // 1. Purge every cache on this origin (including the poisoned ones).
      try {
        const names = await caches.keys();
        await Promise.all(names.map((name) => caches.delete(name)));
      } catch {
        // Cache Storage unavailable — continue with unregistration.
      }

      // 2. Take control of any open pages so we can reload them.
      try {
        await self.clients.claim();
      } catch {
        // Ignore — reload below still works for future navigations.
      }

      // 3. Remove this worker so the origin is no longer controlled.
      try {
        await self.registration.unregister();
      } catch {
        // Ignore.
      }

      // 4. Reload open pages so they pull fresh HTML (and the current bundle).
      try {
        const clients = await self.clients.matchAll({ type: 'window' });
        for (const client of clients) {
          if ('navigate' in client) {
            client.navigate(client.url);
          }
        }
      } catch {
        // Ignore — the next manual reload will be clean.
      }
    })(),
  );
});

// Pass every request straight through. Nothing is cached, ever.
self.addEventListener('fetch', () => {
  // No respondWith() → default browser network handling.
});
