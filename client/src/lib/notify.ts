// Tab-open Web Notifications: buzz the user when the agent finishes or needs an
// approval while pantoken ISN'T the focused window. Web Push (tab fully closed) is
// deferred — see OPEN-QUESTIONS OQ5. Permission is requested lazily on a user gesture.

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

/**
 * Pure decision for whether to surface a tab-open notification. Keyed off *focus*,
 * not visibility: a desktop window that's on-screen but not the active OS window
 * (you're in the terminal or another app) should still buzz — only the window you're
 * actively looking at stays quiet. "Not focused" subsumes hidden/minimized, so this
 * one signal replaces the old visibilityState check. Kept pure for unit testing.
 */
export function shouldNotify(opts: {
  supported: boolean;
  permission: NotificationPermission;
  focused: boolean;
}): boolean {
  return opts.supported && opts.permission === "granted" && !opts.focused;
}

/** Fire a notification when pantoken is unfocused and permission is granted. */
export function notifyIfUnfocused(
  title: string,
  body: string,
  opts: { tag?: string; onClick?: () => void } = {},
): void {
  const supported = notificationsSupported();
  const focused = typeof document !== "undefined" && document.hasFocus();
  if (
    !shouldNotify({
      supported,
      permission: supported ? Notification.permission : "denied",
      focused,
    })
  )
    return;
  try {
    const n = new Notification(title, {
      body,
      icon: "/icon.svg",
      tag: opts.tag ?? "pantoken",
    });
    n.onclick = () => {
      window.focus();
      opts.onClick?.();
      n.close();
    };
  } catch {
    /* some browsers throw if constructed outside a SW for certain configs */
  }
}
