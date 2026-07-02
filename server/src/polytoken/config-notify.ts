/** Error-notify helpers for config setters (setModel, setThinking, setFacet,
 *  setPermissionMonitor, abort). Extracted from polytoken-driver.ts so the
 *  "emit a visible error notify on failure" pattern is unit-testable without
 *  a running daemon.
 *
 *  The driver's config setters used to `.catch(console.error)` only — the
 *  operator got no visible signal when a model/facet/monitor change failed.
 *  These helpers implement the same error-notify pattern `respondUi` uses
 *  inline (hostUiRequest{kind:"notify", level:"error"}), plus optional
 *  rollback for optimistic setters (setPermissionMonitor). */

import type { SessionDriverEvent, SessionRef, Timestamp } from "@pilot/protocol";

/** Build a `hostUiRequest{kind:"notify", level:"error"}` event. Pure — no I/O.
 *  The `requestId` is namespaced by `operation` so the client can deduplicate
 *  if needed (e.g. `setModel-failed-<timestamp>`). */
export function errorNotify(
  ref: SessionRef,
  timestamp: Timestamp,
  operation: string,
  message: string,
): SessionDriverEvent {
  return {
    type: "hostUiRequest",
    sessionRef: ref,
    timestamp,
    request: {
      kind: "notify",
      requestId: `${operation}-failed-${timestamp.replace(/[:.]/g, "-")}`,
      message,
      level: "error",
    },
  };
}

/** Wrap a promise so that on rejection it emits an error notify via the
 *  provided `emit` callback, then optionally runs `rollback`. Returns void
 *  (fire-and-forget) — the caller doesn't await this; the error is surfaced
 *  via the notify, not a thrown promise.
 *
 *  This is the pattern the config setters should use instead of
 *  `.catch(console.error)`:
 *  - `promise`: the daemon POST (e.g. `ws.client.setModel(...)`)
 *  - `emit`: the driver's `emit` closure
 *  - `ref`: the warm session's `ws.ref`
 *  - `now`: timestamp factory (the driver's `now()` closure)
 *  - `operation`: short name for the requestId namespace (e.g. "setModel")
 *  - `message`: the human-readable error prefix (e.g. "Failed to set model")
 *  - `rollback`: optional cleanup on failure (e.g. restoring the previous
 *    permission monitor mode) */
export function withErrorNotify(
  promise: Promise<unknown>,
  emit: (ev: SessionDriverEvent) => void,
  ref: SessionRef,
  now: () => Timestamp,
  operation: string,
  message: string,
  rollback?: () => void,
): void {
  void promise.catch((e: unknown) => {
    const detail = e instanceof Error ? e.message : String(e);
    const msg = `${message}: ${detail}`;
    console.error(`[polytoken] ${operation} failed`, e);
    emit(errorNotify(ref, now(), operation, msg));
    try {
      rollback?.();
    } catch (rollbackErr) {
      console.error(`[polytoken] ${operation} rollback failed`, rollbackErr);
    }
  });
}
