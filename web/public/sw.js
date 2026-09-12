// Service worker: app-shell precache so the PWA opens instantly / offline.
// Chỉ cache tài nguyên tĩnh cùng origin; không bao giờ cache /api/* (REST+SSE).
const CACHE = "owm-shell-v11";
// index.html dùng navigate-fallback (không precache cứng vì Vite hash asset mỗi build).
const SHELL = [
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-192.png",
  "/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Never cache API/SSE traffic - always go to network.
  if (url.pathname.startsWith("/api/")) return;
  if (event.request.method !== "GET") return;
  // SPA: điều hướng trong app luôn trả index.html (offline vẫn mở được shell).
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match("/").then((r) => r || fetch("/"))));
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response.ok && response.type === "basic") {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
