// Minimal service worker — enough to make pilot installable as a PWA and to host
// future Web Push handlers (see OPEN-QUESTIONS OQ5). Deliberately NOT caching the
// app shell yet: Vite emits hashed asset names, so a precache list would go stale
// every build. Network-first passthrough keeps it correct until we add Workbox.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", () => {
  // passthrough — let the network handle everything for now
});

// Placeholder for M8 Web Push:
// self.addEventListener("push", (e) => { ... show notification ... });
// self.addEventListener("notificationclick", (e) => { ... focus client ... });
