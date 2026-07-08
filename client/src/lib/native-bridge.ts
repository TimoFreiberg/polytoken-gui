// Tiny bridge to the native macOS desktop shell (desktop/Sources/Pantoken/AppDelegate.swift).
// In the packaged app the web client runs inside a WKWebView that registers a `pantokenUpdate`
// script-message handler; everywhere else (browser tab, installed PWA) the handler is absent
// and these calls no-op. Keep messages tiny and best-effort — never let a missing bridge throw.

interface PantokenMessageHandler {
  postMessage(body: unknown): void;
}

function updateHandler(): PantokenMessageHandler | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    webkit?: { messageHandlers?: { pantokenUpdate?: PantokenMessageHandler } };
  };
  return w.webkit?.messageHandlers?.pantokenUpdate ?? null;
}

/** Ask the native shell to raise its fullscreen "Updating Pantoken…" overlay NOW, instead of
 *  waiting ~one updater poll (≈5s) for the updater's first apply event to raise it. Later
 *  apply events refresh the same overlay; teardown is unchanged. No-op outside the desktop
 *  app. */
export function notifyNativeUpdateStarting(): void {
  updateHandler()?.postMessage({ type: "updateStarting" });
}
