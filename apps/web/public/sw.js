// 胡好好 Service Worker：应用外壳缓存 + Web Push 通知
const CACHE = "huhao-shell-v1";
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/", "/manifest.webmanifest", "/icon-192.png"])).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname === "/ws") return;
  // 网络优先，离线时用缓存（导航请求回落到 /）
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && (url.pathname.startsWith("/assets/") || e.request.mode === "navigate")) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request.mode === "navigate" ? "/" : e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request.mode === "navigate" ? "/" : e.request)),
  );
});
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: "胡好好", body: e.data && e.data.text() }; }
  e.waitUntil((async () => {
    if (d.data && d.data.type === "server-url") {
      const cs = await self.clients.matchAll({ includeUncontrolled: true });
      cs.forEach((c) => c.postMessage({ type: "server-url", ...d.data }));
    }
    await self.registration.showNotification(d.title || "胡好好", { body: d.body || "", tag: d.tag, icon: "/icon-192.png", badge: "/icon-192.png", data: { url: d.url || "/", ...(d.data || {}) } });
  })());
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of cs) { if ("focus" in c) { c.navigate(url).catch(() => {}); return c.focus(); } }
    return self.clients.openWindow(url);
  })());
});
