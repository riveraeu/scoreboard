/* Scoreboard service worker — Web Push for installed (Home Screen) PWAs.
 * iOS 16.4+ only delivers push to a standalone-installed PWA, never a Safari tab.
 * Kept deliberately tiny: no precache/offline logic, just push + notification routing. */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = {}; }
  const title = payload.title || "Scoreboard";
  const options = {
    body: payload.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: payload.tag || undefined,        // collapse repeats with the same tag
    data: { url: payload.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ("focus" in w) { w.navigate?.(target); return w.focus(); }
      }
      return self.clients.openWindow ? self.clients.openWindow(target) : undefined;
    })
  );
});
