/**
 * Backpressure-aware WebSocket sending.
 *
 * Bun's `ServerWebSocket.send()` returns:
 *   -1 — enqueued under backpressure (will deliver, just slow)
 *    0 — DROPPED (message lost; client state may now desync)
 *   >0 — bytes written (sent successfully)
 *
 * A dropped message silently desyncs the client's folded transcript from the
 * server's authoritative state. Rather than corrupting quietly, `sendOrClose`
 * closes the connection on a drop — the client's reconnect machinery re-snapshots
 * from scratch. (crash-don't-corrupt philosophy)
 */

/** Minimal socket interface for testable backpressure-aware sending. */
export interface SendableSocket {
  /** 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED (WebSocket standard). */
  readonly readyState: number;
  /** Bun's ServerWebSocket.send: -1=enqueued(backpressure), 0=dropped, >0=bytes.
   *  `compress` opts this frame into the negotiated permessage-deflate — Bun
   *  only compresses when it's passed per send. */
  send(data: string, compress?: boolean): number;
  close(code?: number, reason?: string): void;
}

/** Frames at or under this size skip deflate: the CPU + ~6-byte frame overhead
 *  isn't worth it for tiny acks/deltas, while markdown bubbles, snapshots, and
 *  seed events (the frames that dominate bytes on the wire) compress 4-40x. */
export const COMPRESS_MIN_BYTES = 512;

/**
 * Send a string message, detecting Bun's backpressure-drop signal.
 *
 * Frames larger than {@link COMPRESS_MIN_BYTES} are sent with the per-send
 * compress flag — `perMessageDeflate: true` in the server config only
 * *negotiates* the extension; Bun compresses nothing unless each send asks.
 *
 * Returns `true` if the connection was closed (message was dropped), `false`
 * otherwise. Skips sends to an already-closing/closed socket (`readyState >= 2`)
 * without calling `send` or `close` — e.g. a prior send in the same synchronous
 * batch already detected a drop and closed it.
 */
export function sendOrClose(ws: SendableSocket, data: string): boolean {
  if (ws.readyState >= 2) return false;
  const result = ws.send(data, data.length > COMPRESS_MIN_BYTES);
  if (result === 0) {
    ws.close(1011, "backpressure drop");
    return true;
  }
  return false;
}

/**
 * Serialize + send a message, invoking `onDrop` if it was dropped (backpressure).
 *
 * This is the full `rawSend` wiring: `JSON.stringify` → `sendOrClose` → `onDrop`.
 * The caller passes its own `onDrop` callback — in production this is
 * `() => log.warn(...)`.
 *
 * Returns `true` if the message was dropped (and the connection closed).
 */
export function sendJson(
  ws: SendableSocket,
  data: unknown,
  onDrop?: () => void,
): boolean {
  const dropped = sendOrClose(ws, JSON.stringify(data));
  if (dropped && onDrop) onDrop();
  return dropped;
}
