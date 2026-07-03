// Tiny bridge to the native macOS desktop shell (desktop/Sources/Pilot/AppDelegate.swift).
// In the packaged app the web client runs inside a WKWebView that registers a `pilotUpdate`
// script-message handler; everywhere else (browser tab, installed PWA) the handler is absent
// and these calls no-op. Keep messages tiny and best-effort — never let a missing bridge throw.

interface PilotMessageHandler {
  postMessage(body: unknown): void;
}

function updateHandler(): PilotMessageHandler | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    webkit?: { messageHandlers?: { pilotUpdate?: PilotMessageHandler } };
  };
  return w.webkit?.messageHandlers?.pilotUpdate ?? null;
}

/** Ask the native shell to raise its fullscreen "Updating Pilot…" overlay NOW, instead of
 *  waiting ~one updater poll (≈5s) for the updater's first apply event to raise it. Later
 *  apply events refresh the same overlay; teardown is unchanged. No-op outside the desktop
 *  app. */
export function notifyNativeUpdateStarting(): void {
  updateHandler()?.postMessage({ type: "updateStarting" });
}
