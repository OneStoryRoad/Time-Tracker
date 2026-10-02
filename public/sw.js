const CACHE = "time-ledger-shell-v1";
self.addEventListener("install", (event) =>
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const response = await fetch("/");
      const html = await response.clone().text();
      await cache.put("/", response);
      const assets = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)]
        .map((m) => m[1])
        .filter((u) => u.startsWith("/assets/"));
      await cache.addAll([
        ...assets,
        "/manifest.webmanifest",
        "/icon.png",
        "/icon-512.png",
      ]);
    })(),
  ),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
        ),
      ),
  ),
);
self.addEventListener("fetch", (event) => {
  const u = new URL(event.request.url);
  if (
    u.origin !== location.origin ||
    u.pathname.startsWith("/api") ||
    event.request.method !== "GET"
  )
    return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (
          res.ok &&
          (u.pathname === "/" ||
            u.pathname.startsWith("/assets/") ||
            u.pathname.endsWith(".png"))
        ) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() =>
        caches
          .match(event.request)
          .then(
            (r) =>
              r ||
              (event.request.mode === "navigate"
                ? caches.match("/")
                : Response.error()),
          ),
      ),
  );
});
self.addEventListener("message", (event) => {
  if (event.data === "PURGE") event.waitUntil(caches.delete(CACHE));
});
