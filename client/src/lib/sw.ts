// Service-worker registration + update detection. public/sw.js calls skipWaiting()
// on install, so a new version activates immediately; we surface a refresh prompt the
// moment a new worker reaches the "installed" state while an old one already controls
// the page — i.e. a genuine update, not the first install (which has no controller).

export function registerServiceWorker(onUpdate: () => void): void {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        reg.addEventListener("updatefound", () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (
              installing.state === "installed" &&
              navigator.serviceWorker.controller
            ) {
              onUpdate();
            }
          });
        });
      })
      .catch((e) => console.warn("[sw] register failed", e));
  });
}
