//! WebSocket adapter over [`ConnectionSession`].
//!
//! Wraps an `axum::extract::ws::WebSocket` so the session can drive it as a
//! `TransportSplit`. The WS wire format is **raw `ClientMessage`/`ServerMessage`
//! JSON** — no envelope — per the operator-confirmed Option A decision. The
//! browser still receives `{"type":"hello",...}`, not `{"message":{...}}`.
//!
//! Preserves the existing `TCP_NODELAY`/backpressure behavior: the axum WS
//! sink is awaited directly (no unbounded buffering), and `Message::Text` is
//! the only frame kind used (mirrors the old `handle_ws_connection`).

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use pantoken_protocol::wire::{ClientMessage, ServerMessage};
use tracing::warn;

use crate::connection::{Transport, TransportRead, TransportSplit, TransportWrite};

/// A WebSocket adapter implementing [`Transport`] (pre-split, used by the hello
/// gate) and [`TransportSplit`] (split into reader/writer for the pump + inbound
/// loop).
pub struct WsAdapter {
    ws: WebSocket,
}

impl WsAdapter {
    pub fn new(ws: WebSocket) -> Self {
        Self { ws }
    }
}

#[async_trait::async_trait]
impl Transport for WsAdapter {
    async fn recv(&mut self) -> Option<ClientMessage> {
        loop {
            let msg = self.ws.next().await?;
            match msg {
                Ok(Message::Text(text)) => {
                    let parsed: serde_json::Value = match serde_json::from_str(&text) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    // Skip anything that's not a recognizable ClientMessage —
                    // the old code did `continue` on JSON parse errors too.
                    match serde_json::from_value::<ClientMessage>(parsed) {
                        Ok(m) => return Some(m),
                        Err(e) => {
                            warn!("failed to parse client message: {e}");
                            continue;
                        }
                    }
                }
                Ok(Message::Binary(_)) => continue,
                Ok(Message::Close(_)) | Err(_) => return None,
                // Ping/Pong frames at the WS layer are handled by axum
                // internally; the application-level Ping is a ClientMessage.
                _ => continue,
            }
        }
    }

    async fn send(&mut self, msg: ServerMessage) -> bool {
        let json = serde_json::to_string(&msg).unwrap_or_default();
        self.ws.send(Message::Text(json.into())).await.is_ok()
    }

    async fn close(&mut self) {
        // Send a Close frame; ignore errors (peer may have gone).
        let _ = self.ws.send(Message::Close(None)).await;
    }
}

/// Split a WebSocket into a reader and writer so the outbound pump can own the
/// writer while the inbound loop owns the reader.
///
/// This implements the same ownership split as the old `handle_ws_connection`:
/// `ws.split()` → `ws_sink` (owned by the pump task) + `ws_stream` (owned by
/// the main loop).
impl TransportSplit for WsAdapter {
    type Reader = WsReader;
    type Writer = WsWriter;

    fn split(self) -> (Self::Reader, Self::Writer) {
        let (sink, stream) = self.ws.split();
        (WsReader { stream }, WsWriter { sink })
    }
}

/// The read half of a split WebSocket.
pub struct WsReader {
    stream: futures_util::stream::SplitStream<WebSocket>,
}

#[async_trait::async_trait]
impl TransportRead for WsReader {
    async fn recv(&mut self) -> Option<ClientMessage> {
        loop {
            let msg = self.stream.next().await?;
            match msg {
                Ok(Message::Text(text)) => {
                    let parsed: serde_json::Value = match serde_json::from_str(&text) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    match serde_json::from_value::<ClientMessage>(parsed) {
                        Ok(m) => return Some(m),
                        Err(e) => {
                            warn!("failed to parse client message: {e}");
                            continue;
                        }
                    }
                }
                Ok(Message::Binary(_)) => continue,
                Ok(Message::Close(_)) | Err(_) => return None,
                _ => continue,
            }
        }
    }
}

/// The write half of a split WebSocket.
///
/// Owns the sink half of the split `WebSocket`. The concrete sink type
/// (`SplitSink<WebSocket, Message>`) is an alias re-exported by axum; we keep
/// it as a type parameter so we don't have to name it by full path here.
pub struct WsWriter {
    sink: futures_util::stream::SplitSink<WebSocket, Message>,
}

#[async_trait::async_trait]
impl TransportWrite for WsWriter {
    async fn send(&mut self, msg: ServerMessage) -> bool {
        let json = serde_json::to_string(&msg).unwrap_or_default();
        self.sink.send(Message::Text(json.into())).await.is_ok()
    }

    async fn close(&mut self) {
        let _ = self.sink.send(Message::Close(None)).await;
    }
}
