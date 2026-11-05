const CACHE = "meridex-shell-v3";
const SHELL = ["/", "/offline", "/mark.svg", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  // Drop caches from older versions (v2 could hold third-party responses).
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Only handle our own origin. Third-party requests (e.g. Tawk.to chat) go straight to the network;
  // intercepting them made failed cross-origin fetches fall back to the /offline HTML page.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api") || url.pathname.startsWith("/ws") || url.pathname.startsWith("/_next")) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => undefined);
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("/offline"))),
  );
});
