// Tab-open Web Notifications: buzz the user when the agent finishes or needs an
// approval while the tab is backgrounded. Web Push (tab fully closed) is deferred —
// see OPEN-QUESTIONS OQ5. Permission is requested lazily on a user gesture.

export function notificationsSupported(): boolean {
  return typeof Notification !== "undefined";
}

/** Request permission. Must be called from a user gesture (e.g. sending a prompt). */
export function ensurePermission(): void {
  if (!notificationsSupported()) return;
  if (Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}

/** Fire a notification only when the tab is hidden and permission is granted. */
export function notifyIfHidden(title: string, body: string): void {
  if (!notificationsSupported()) return;
  if (Notification.permission !== "granted") return;
  if (typeof document !== "undefined" && document.visibilityState === "visible")
    return;
  try {
    const n = new Notification(title, {
      body,
      icon: "/icon.svg",
      tag: "pilot",
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* some browsers throw if constructed outside a SW for certain configs */
  }
}
