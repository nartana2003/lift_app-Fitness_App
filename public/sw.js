// Lift service worker: offline app shell + catalogue/image caching + push.
const VERSION = "v1";
const SHELL = `shell-${VERSION}`;
const DATA = `data-${VERSION}`;
const IMAGES = "exercise-images";
const PRECACHE = ["/", "/exercises", "/workout", "/progress", "/exercises.json", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL).then((c) => Promise.allSettled(PRECACHE.map((u) => c.add(u)))),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => ![SHELL, DATA, IMAGES].includes(k)).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Exercise demo images: cache-first, they never change.
  if (url.hostname === "raw.githubusercontent.com") {
    event.respondWith(cacheFirst(req, IMAGES));
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  // Static build assets: cache-first.
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(cacheFirst(req, SHELL));
    return;
  }
  // Catalogue: stale-while-revalidate.
  if (url.pathname === "/exercises.json") {
    event.respondWith(staleWhileRevalidate(req, DATA));
    return;
  }
  // Pages: network-first, fall back to cache when offline.
  if (req.mode === "navigate" || req.headers.get("accept")?.includes("text/html")) {
    event.respondWith(networkFirst(req, SHELL));
  }
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const net = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => hit);
  return hit || net;
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req)) || (await cache.match("/")) || Response.error();
  }
}

// Pre-cache images for planned exercises (posted from the app before gym days).
self.addEventListener("message", (event) => {
  if (event.data?.type === "precache-images") {
    caches.open(IMAGES).then((c) => Promise.allSettled(event.data.urls.map((u) => c.add(u))));
  }
});

// ---------- Push notifications ----------
self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(data.title || "Lift", {
      body: data.body || "",
      icon: "/icons/192",
      badge: "/icons/192",
      tag: data.tag,
      data: { url: data.url || "/", kind: data.kind },
      actions: data.actions || [],
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { url, kind } = event.notification.data || {};
  if (event.action === "skip" || event.action === "snooze") {
    event.waitUntil(
      fetch("/api/reminders/snooze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: event.action, kind }),
        credentials: "include",
      }).catch(() => {}),
    );
    return;
  }
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((list) => {
      const open = list.find((c) => "focus" in c);
      if (open) {
        open.navigate(url);
        return open.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
