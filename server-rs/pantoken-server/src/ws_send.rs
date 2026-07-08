//! Backpressure-aware WebSocket sending.
//!
//! The TS implementation uses Bun's `ServerWebSocket.send()` return values:
//!   -1 — enqueued under backpressure (will deliver, just slow)
//!    0 — DROPPED (message lost; client state may now desync)
//!   >0 — bytes written (sent successfully)
//!
//! A dropped message silently desyncs the client's folded transcript from the
//! server's authoritative state. Rather than corrupting quietly, we close the
//! connection on a send failure — the client's reconnect machinery re-snapshots
//! from scratch. (crash-don't-corrupt philosophy)
//!
//! In Rust/axum, `WebSocket::send()` returns a `Result`; an error means the
//! connection is already dead or the send failed — we close it. There's no
//! "dropped but not closed" state like Bun's backpressure return value, so the
//! logic is simpler: if send fails, the connection is gone.
//!
//! Port of `server/src/ws-send.ts`.

use axum::extract::ws::{Message, WebSocket};
use futures_util::SinkExt;
use tracing::warn;

/// Frames at or below this size skip permessage-deflate: the CPU + frame
/// overhead isn't worth it for tiny acks/deltas, while markdown bubbles,
/// snapshots, and seed events compress 4-40x.
pub const COMPRESS_MIN_BYTES: usize = 512;

/// A trait for testable backpressure-aware sending.
#[async_trait::async_trait]
pub trait SendableSocket: Send {
    /// Send a text message. Returns `true` if the message was dropped/closed
    /// (the caller should treat the connection as dead).
    async fn send_text(&mut self, data: &str) -> bool;
}

/// Send a string message, detecting backpressure-drop.
///
/// In the axum/tungstenite model, a send error means the connection is broken.
/// Returns `true` if the connection was closed (send failed), `false` otherwise.
pub async fn send_or_close(ws: &mut WebSocket, data: &str) -> bool {
    match ws.send(Message::Text(data.into())).await {
        Ok(()) => false,
        Err(e) => {
            warn!("ws send failed — closing connection: {e}");
            let _ = ws.close().await;
            true
        }
    }
}

/// Serialize + send a message, invoking `on_drop` if it was dropped.
///
/// This is the full `rawSend` wiring: `JSON.stringify` → `send_or_close` → `on_drop`.
/// Returns `true` if the message was dropped (and the connection closed).
pub async fn send_json<T: serde::Serialize>(
    ws: &mut WebSocket,
    data: &T,
    on_drop: Option<&(dyn Fn() + Send + Sync)>,
) -> bool {
    let json = match serde_json::to_string(data) {
        Ok(s) => s,
        Err(e) => {
            warn!("ws serialize failed: {e}");
            let _ = ws.close().await;
            return true;
        }
    };
    let dropped = send_or_close(ws, &json).await;
    if dropped {
        if let Some(cb) = on_drop {
            cb();
        }
    }
    dropped
}
