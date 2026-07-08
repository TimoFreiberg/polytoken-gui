// Minimal service worker — enough to make pantoken installable as a PWA and to host
// future Web Push handlers (see OPEN-QUESTIONS OQ5). Deliberately NOT caching the
// app shell yet: Vite emits hashed asset names, so a precache list would go stale
// every build. Network-first passthrough keeps it correct until we add Workbox.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", () => {
  // passthrough — let the network handle everything for now
});

// Web Push: deliver a notification even when every tab is closed. Payload is the
// JSON the server sends in PushService.sendToAll ({title, body, tag, url}).
//
// Foreground suppression: if a pantoken window is already focused/visible, the user is
// looking at the app — an OS notification would be redundant (and on desktop it
// double-buzzes alongside the in-tab notify.ts path and the terminal pi notify
// extension). So when foreground we SKIP the OS notification and let the live WS
// connection drive any in-app reaction: the focused client already receives the
// underlying agent events and runs notify.ts itself. We also postMessage the payload
// to open clients as a forward-looking hook — but note NO client registers a
// serviceWorker "message" listener yet, so today that send is a deliberate no-op
// reserved for future in-app handling (see followups).
//
// TRADE-OFF / CAVEAT: this subscription is userVisibleOnly:true, which contractually
// obliges the SW to show a *user-visible* notification for every push. Some browsers
// (notably Chrome) enforce this: if you repeatedly receive a push and don't show a
// notification, Chrome may show its own generic "This site has been updated in the
// background" notification, or eventually revoke the push subscription as a budget
// penalty. We accept that risk here because (a) pushes are infrequent and tied to
// real agent events, and (b) the alternative (always showing) is the double-buzz bug
// we're fixing. If Chrome's penalty notification proves annoying in practice, switch
// the `if (foreground)` branch below to show a near-silent minimal notification
// instead of fully skipping (renotify:false, silent:true). See followups.
self.addEventListener("push", (event) => {
  let data = { title: "pantoken", body: "" };
  try {
    if (event.data) data = event.data.json();
  } catch {
    /* malformed payload — fall back to defaults */
  }

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      // Foreground = at least one pantoken window is focused or visible. focused is the
      // strongest signal; visibilityState === "visible" covers a foreground tab that
      // doesn't currently hold OS focus (e.g. focus is in a devtools pane) but is
      // still on-screen for the user.
      const foreground = windows.some(
        (c) => c.focused === true || c.visibilityState === "visible",
      );

      if (foreground) {
        // App is in front — skip the OS buzz; the live WS connection already drives
        // in-app reaction. The postMessage is a reserved hook (no SW-message listener
        // exists yet), not the mechanism that surfaces this push in-app today.
        for (const c of windows) {
          c.postMessage({ type: "push", payload: data });
        }
        return;
      }

      await self.registration.showNotification(data.title || "pantoken", {
        body: data.body || "",
        tag: data.tag || "pantoken",
        icon: "/icon.svg",
        data: { url: data.url || "/" },
      });
    })(),
  );
});

// Focus an existing window if one is open, otherwise open the app.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (clients) => {
        for (const c of clients) {
          if ("navigate" in c) await c.navigate(url);
          if ("focus" in c) return c.focus();
        }
        return self.clients.openWindow
          ? self.clients.openWindow(url)
          : undefined;
      }),
  );
});
