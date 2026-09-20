import { createRoot } from 'react-dom/client';

// Import polyfills first
import './lib/polyfills.ts';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import App from './App.tsx';
import './index.css';

// Custom font: none shipped yet — one can be added with e.g.:
// import '@fontsource-variable/<font-name>';

// Service worker: intentionally NOT registered.
//
// An earlier version cached index.html and served hashed JS cache-first with no
// invalidation, which pinned browsers to a stale bundle and kept replaying an
// already-fixed error. public/sw.js is now a self-destructing kill switch that
// purges all caches and unregisters itself; the browser fetches it on its own,
// so nothing here needs to run for recovery to happen.
//
// Belt-and-braces: if a worker still controls this origin, tear it down and
// clear Cache Storage from the page side too.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void (async () => {
      try {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((r) => r.unregister()));
      } catch {
        // Ignore — nothing we can do from here.
      }

      try {
        if ('caches' in window) {
          const names = await caches.keys();
          await Promise.all(names.map((name) => caches.delete(name)));
        }
      } catch {
        // Ignore.
      }
    })();
  });
}

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
