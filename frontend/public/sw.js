// ── UrumTrader Service Worker ─────────────────────────────────────────────────
// Strategy:
//   - Static assets (JS/CSS/HTML/icons): cache-first, update in background
//   - API calls (/api/*): network-only — never serve stale trade data
//   - Everything else: network-first, fall back to cache

const CACHE_NAME = "urumtrader-v1";

const PRECACHE_URLS = [
  "/",
  "/index.html",
  "/landing.html",
  "/manifest.json",
  "/icon.svg",
];

// ── Install: precache shell ────────────────────────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: clean up old caches ─────────────────────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE_NAME)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 1. API calls — always go to network, never cache trade/bot data
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(request));
    return;
  }

  // 2. Static assets (hashed filenames) — cache-first
  if (
    url.pathname.startsWith("/assets/") ||
    /\.(js|css|woff2?|png|svg|ico)$/.test(url.pathname)
  ) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((res) => {
            if (res.ok) {
              const clone = res.clone();
              caches.open(CACHE_NAME).then((c) => c.put(request, clone));
            }
            return res;
          })
      )
    );
    return;
  }

  // 3. HTML navigation — network-first, fall back to cached shell
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(request, clone));
          }
          return res;
        })
        .catch(() => caches.match(request).then((c) => c ?? caches.match("/")))
    );
    return;
  }

  // 4. Default — network-first
  event.respondWith(
    fetch(request).catch(() => caches.match(request))
  );
});
