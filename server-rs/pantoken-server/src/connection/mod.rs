//! Transport-neutral reusable connection session.
//!
//! Extracts the per-connection logic that used to live inline in
//! `main.rs::handle_ws_connection` (hello auth/registration, hub input dispatch,
//! outbound message pumping, heartbeat, orderly close, hub removal) behind a
//! small [`Transport`] trait so the same session can run over either:
//!
//! - the existing Axum WebSocket adapter ([`ws::WsAdapter`]) — raw
//!   `ClientMessage`/`ServerMessage` JSON, **no envelope** (operator-confirmed
//!   Option A: the WS wire format stays unchanged so the browser never notices);
//! - the framed-stdio adapter (Phase 1.2) — length-prefixed
//!   `WireEnvelope`-wrapped frames, used by the SSH stdio transport.
//!
//! ## Why a trait, not `Box<dyn Transport>`
//!
//! The session is generic over `T: Transport` so the monomorphized WS path
//! stays a zero-cost direct dispatch (preserving the existing WS handler's
//! hot-loop performance), while the stdio path compiles to its own
//! monomorphization over the same session body. Both share the exact same
//! control flow — the regression guarantee of AC.1.
//!
//! ## Envelope asymmetry (documented centrally in `docs/DESIGN.md`)
//!
//! The session speaks **raw logical messages** (`ClientMessage` /
//! `ServerMessage`), not envelopes. The WS adapter serializes raw JSON; the
//! stdio adapter wraps in `WireEnvelope` + length-prefixed frame at the
//! transport boundary. The logical envelope is never exposed to the browser.

pub mod stdio;
pub mod ws;

use std::sync::Arc;

use pantoken_protocol::wire::{ClientMessage, ResumeToken, ServerMessage};
use parking_lot::Mutex as ParkingMutex;
use tracing::warn;

use crate::config::{self, Config};
use crate::hub::SessionHub;

/// The transport contract the session drives.
///
/// The session owns the connection lifecycle; the transport owns the raw
/// byte stream. The session calls `recv` for inbound logical messages and
/// `send` for outbound logical messages — the transport is responsible for
/// any wire-level encoding/decoding (raw JSON for WS, envelope+frame for
/// stdio).
///
/// All three methods are `async` and take `&mut self`; the session holds the
/// transport exclusively. `recv` returns `None` on a clean transport close
/// (EOF) or an unrecoverable read error — the session treats both the same
/// (orderly teardown). `send` returns `false` if the write could not be
/// completed (transport closed/broken); the session tears down on `false`.
/// `close` is best-effort and infallible (the transport is dropped after).
///
/// This trait is internal to the `connection` module — not a public API.
#[async_trait::async_trait]
pub trait Transport: Send {
    /// Receive the next inbound logical message, or `None` on transport close.
    async fn recv(&mut self) -> Option<ClientMessage>;

    /// Send an outbound logical message. Returns `false` if the transport can
    /// no longer accept writes (session should tear down).
    async fn send(&mut self, msg: ServerMessage) -> bool;

    /// Best-effort close. Called exactly once at session teardown. Infallible.
    async fn close(&mut self);
}

/// Inputs the session needs from the host process — the hub, config (for auth
/// token checks), and a server identity for diagnostics. Cloned cheaply
/// (everything is `Arc`).
#[derive(Clone)]
pub struct SessionEnv {
    pub hub: Arc<ParkingMutex<SessionHub>>,
    pub config: Arc<Config>,
}

/// The reusable connection session.
///
/// Owns the per-connection state machine: hello gate → register with hub →
/// outbound pump + inbound dispatch → orderly close + hub removal. The
/// transport is driven by [`ConnectionSession::run`], which consumes the
/// session and returns when the connection ends (transport EOF, auth failure,
/// or channel close).
pub struct ConnectionSession<T: Transport> {
    transport: T,
    env: SessionEnv,
}

impl<T: Transport + TransportSplit> ConnectionSession<T> {
    /// Construct a session over the given transport, sharing the hub + config.
    pub fn new(transport: T, env: SessionEnv) -> Self {
        Self { transport, env }
    }

    /// Drive the connection to completion.
    ///
    /// This is the exact control flow that used to live inline in
    /// `handle_ws_connection`: wait for hello, auth-check, register with the
    /// hub, spawn the outbound pump, then loop on inbound dispatch until the
    /// transport closes, and finally remove the client from the hub.
    ///
    /// Returns when the transport is closed (EOF, auth failure, or pump
    /// termination). The hub is always cleaned up on return.
    pub async fn run(mut self)
    where
        <T as TransportSplit>::Reader: 'static,
        <T as TransportSplit>::Writer: 'static,
    {
        // ── Hello gate ──────────────────────────────────────────────────
        //
        // Wait for the first ClientMessage::Hello, check auth, parse resume.
        // Non-hello first message or auth failure → close. Mirrors the
        // ws_stream.next() loop in the old handle_ws_connection.
        //
        // Structurally a loop to mirror the old code's `loop { ws_stream.next() }`
        // shape (which skipped non-text frames), but every branch returns or
        // breaks — clippy flags this as never_loop, which is technically correct
        // (the loop body executes at most once per invocation). The WS adapter's
        // recv() already filters non-text frames, so the loop is single-pass.
        #[allow(clippy::never_loop)]
        let resume: Option<ResumeToken> = loop {
            let Some(msg) = self.transport.recv().await else {
                // Transport closed before hello.
                return;
            };
            match msg {
                ClientMessage::Hello { auth, resume } => {
                    if !config::token_ok(auth.as_deref(), &self.env.config) {
                        // Auth failure — close. (The old code `return`ed
                        // without sending a close frame because there's no
                        // sink in the hello-gate loop; we mirror that — the
                        // transport's close() is best-effort and the peer
                        // sees a dropped connection.)
                        self.transport.close().await;
                        return;
                    }
                    break resume;
                }
                // Non-hello first message → reject, mirroring the old code.
                _ => {
                    self.transport.close().await;
                    return;
                }
            }
        };

        // ── Register with the hub ───────────────────────────────────────
        //
        // add_client returns (client_key, tx, rx). tx is a clone of what's
        // stored in the ClientConn (we drop it — the hub owns the live one).
        // rx goes to the pump task. spawn_connect_lists fires the async
        // sessionList/modelList/commandList/facetList/fileIndex follow-ups.
        let (client_key, _tx, rx) = {
            let mut hub = self.env.hub.lock();
            let result = hub.add_client(resume);
            hub.spawn_connect_lists(result.0);
            result
        };
        // Drop the returned tx clone immediately — the hub's ClientConn holds
        // the only other clone, so rx.recv() returns None once the client is
        // removed from the hub. (Mirrors the old handle_ws_connection which
        // dropped `_tx` implicitly.)
        drop(_tx);

        // ── Outbound pump ────────────────────────────────────────────────
        //
        // A spawned task owns the transport's send side, reading ServerMessages
        // from the hub channel (buffer 128 — set in hub.add_client) and writing
        // them out. On channel close (client removed from hub → tx dropped → rx
        // returns None) the pump closes the transport and exits.
        //
        // The pump borrows the transport's send capability, so we split it out
        // via a oneshot/pump-owned sender. Because Transport is `&mut self` on
        // send, we can't share it between the pump and the inbound loop. The
        // clean split: the pump owns a channel of outbound ServerMessages, and
        // a dedicated writer task drains that channel into the transport.
        //
        // But the transport is a single object — we need the pump to write to
        // it while the main loop reads from it. The classic solution is to
        // split the transport into a read half and a write half. Rather than
        // force every Transport to be splittable (which complicates the trait
        // and the stdio adapter), we instead spawn the pump as a task that
        // owns the channel receiver and sends messages through a shared
        // mpsc back to a single writer that owns the transport's send side.
        //
        // Simpler and proven shape (matches the old handle_ws_connection
        // exactly): the main loop owns the transport. The pump task owns only
        // the rx channel and forwards each ServerMessage to the transport via
        // an mpsc::Sender<ServerMessage> that the main loop drains alongside
        // inbound reads. This keeps the transport in one place and uses
        // tokio::select! to interleave.
        //
        // However, the old code spawned a *separate* pump task that owned the
        // sink exclusively — so outbound writes didn't block inbound reads. We
        // preserve that by splitting the transport into (reader, writer)
        // halves via a TransportSplit trait method. See below.

        let (mut reader, writer) = self.transport.split();

        // Outbound pump: owns the writer half + the hub channel receiver.
        let pump = tokio::spawn(async move {
            let mut rx = rx;
            let mut writer = writer;
            while let Some(msg) = rx.recv().await {
                if !writer.send(msg).await {
                    break;
                }
            }
            // Channel closed (client removed from hub) — close the write half.
            writer.close().await;
        });

        // ── Inbound dispatch ─────────────────────────────────────────────
        //
        // Read ClientMessages, skip hello (already authed), dispatch to the
        // hub. handle_client is sync; driver work is spawned as separate
        // HubOp tasks. Mirrors main.rs:376–410.
        while let Some(msg) = reader.recv().await {
            match msg {
                ClientMessage::Hello { .. } => {
                    // Already authed — skip (a re-hello is a no-op, matching
                    // the old code's `if type == "hello" { continue; }`).
                    continue;
                }
                other => {
                    let mut hub = self.env.hub.lock();
                    hub.handle_client(client_key, other);
                }
            }
        }

        // ── Cleanup ──────────────────────────────────────────────────────
        //
        // Transport EOF/error → remove the client from the hub (drops the tx,
        // closing the pump's rx → pump exits → writer closes).
        {
            let mut hub = self.env.hub.lock();
            hub.remove_client(client_key);
        }
        // Wait for the pump to finish so we don't leak a task.
        let _ = pump.await;
        // reader is dropped here; the write half was consumed by the pump.
    }
}

/// A splittable transport: separates the read and write halves so the outbound
/// pump can own the writer while the inbound loop owns the reader.
///
/// Every `Transport` implementation must also implement `TransportSplit`. The
/// `Transport` supertrait bound here keeps the trait hierarchy flat for callers
/// that don't need to split (they just use `Transport`).
pub trait TransportSplit: Transport + Sized {
    type Reader: TransportRead + Send + 'static;
    type Writer: TransportWrite + Send + 'static;

    /// Split into read and write halves. The session calls this exactly once
    /// after the hello gate.
    fn split(self) -> (Self::Reader, Self::Writer);
}

/// The read half of a split transport.
#[async_trait::async_trait]
pub trait TransportRead: Send {
    /// Receive the next inbound logical message, or `None` on transport close.
    async fn recv(&mut self) -> Option<ClientMessage>;
}

/// The write half of a split transport.
#[async_trait::async_trait]
pub trait TransportWrite: Send {
    /// Send an outbound logical message. Returns `false` on transport close.
    async fn send(&mut self, msg: ServerMessage) -> bool;

    /// Best-effort close, called exactly once at teardown.
    async fn close(&mut self);
}

// Provide a blanket `Transport` impl for any `TransportSplit` so callers can
// treat a splittable transport as a `Transport` before splitting (used by the
// hello gate, which reads without a separate pump running yet).
//
// We can't blanket-impl `Transport for S: TransportSplit` due to coherence
// (TransportSplit requires Transport, so it'd be cyclic). Instead, adapters
// that need pre-split use implement Transport directly and then split.

/// Shared diagnostics: log a transport-close reason without leaking tokens.
#[allow(dead_code)]
pub(crate) fn log_transport_close(reason: &str) {
    warn!("connection transport closed: {reason}");
}

/// Helper to parse a hello's resume token from a JSON value (used by adapters
/// that decode the first message as raw JSON before deciding it's a hello).
#[allow(dead_code)]
pub(crate) fn parse_resume(value: &serde_json::Value) -> Option<ResumeToken> {
    value
        .get("resume")
        .and_then(|r| serde_json::from_value::<ResumeToken>(r.clone()).ok())
}

#[cfg(test)]
mod tests {
    //! Named validations (unit level):
    //! - `connection_session_hello_gate_auth_accept`
    //! - `connection_session_hello_gate_auth_reject`
    //! - `connection_session_rejects_non_hello_first_message`
    //! - `connection_session_ping_pong_routing`
    //! - `connection_session_cleanup_on_eof`
    //!
    //! Adapter-level contract tests (WS + stdio parity) live in
    //! `tests/websocket_adapter_contract_tests.rs` and
    //! `tests/stdio_adapter_contract_tests.rs`.

    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    use tokio::sync::mpsc;

    use crate::config::Config;
    use crate::hub::{SessionHub, hub_op_channel};
    use crate::mock_driver::MockDriver;
    use pantoken_protocol::wire::{ClientMessage, ServerMessage};

    /// A splittable in-memory transport: the reader drains inbound, the writer
    /// pushes outbound. Used to test the split/pump path.
    struct InMemorySplitTransport {
        inbound_rx: tokio::sync::mpsc::Receiver<Option<ClientMessage>>,
        outbound_tx: tokio::sync::mpsc::UnboundedSender<ServerMessage>,
        closed: Arc<std::sync::atomic::AtomicBool>,
    }

    #[async_trait::async_trait]
    impl Transport for InMemorySplitTransport {
        async fn recv(&mut self) -> Option<ClientMessage> {
            match self.inbound_rx.recv().await {
                Some(Some(msg)) => Some(msg),
                _ => None,
            }
        }
        async fn send(&mut self, msg: ServerMessage) -> bool {
            self.outbound_tx.send(msg).is_ok()
        }
        async fn close(&mut self) {
            self.closed.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    struct InMemReader {
        inbound_rx: tokio::sync::mpsc::Receiver<Option<ClientMessage>>,
    }
    struct InMemWriter {
        outbound_tx: tokio::sync::mpsc::UnboundedSender<ServerMessage>,
        closed: Arc<std::sync::atomic::AtomicBool>,
    }

    #[async_trait::async_trait]
    impl TransportRead for InMemReader {
        async fn recv(&mut self) -> Option<ClientMessage> {
            match self.inbound_rx.recv().await {
                Some(Some(msg)) => Some(msg),
                _ => None,
            }
        }
    }

    #[async_trait::async_trait]
    impl TransportWrite for InMemWriter {
        async fn send(&mut self, msg: ServerMessage) -> bool {
            self.outbound_tx.send(msg).is_ok()
        }
        async fn close(&mut self) {
            self.closed.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    impl TransportSplit for InMemorySplitTransport {
        type Reader = InMemReader;
        type Writer = InMemWriter;
        fn split(self) -> (Self::Reader, Self::Writer) {
            (
                InMemReader {
                    inbound_rx: self.inbound_rx,
                },
                InMemWriter {
                    outbound_tx: self.outbound_tx,
                    closed: self.closed,
                },
            )
        }
    }

    /// Build a no-auth Config + hub for unit tests.
    fn test_env() -> SessionEnv {
        let dir = tempfile::tempdir().expect("tempdir");
        let cfg = Config {
            port: 0,
            data_dir: dir.path().to_path_buf(),
            vapid_subject: "mailto:test@test.com".into(),
            host: "127.0.0.1".into(),
            token: None,
            debug: true,
            client_dist: dir.path().join("dist"),
            warm_cap: 8,
            idle_reap_ms: 0,
            live_refresh_ms: 1000,
            delta_flush_ms: 0,
        };
        let (hub_ops, _hub_op_rx) = hub_op_channel();
        let driver: Arc<dyn PantokenDriver> = Arc::new(MockDriver::new());
        let hub = SessionHub::new(
            driver,
            hub_ops,
            None,
            1000,
            "test-server-id".into(),
            Some(dir.path().to_path_buf()),
            String::new(),
            0,
        );
        // Leak the tempdir so the hub's paths stay valid for the test's lifetime.
        std::mem::forget(dir);
        SessionEnv {
            hub,
            config: Arc::new(cfg),
        }
    }

    use crate::driver::PantokenDriver;

    /// Helper: build a splittable in-memory transport + handles to drive it.
    fn in_mem_split() -> (
        InMemorySplitTransport,
        tokio::sync::mpsc::Sender<Option<ClientMessage>>,
        tokio::sync::mpsc::UnboundedReceiver<ServerMessage>,
        Arc<std::sync::atomic::AtomicBool>,
    ) {
        let (inbound_tx, inbound_rx) = mpsc::channel(16);
        let (outbound_tx, outbound_rx) = mpsc::unbounded_channel();
        let closed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let transport = InMemorySplitTransport {
            inbound_rx,
            outbound_tx: outbound_tx.clone(),
            closed: closed.clone(),
        };
        (transport, inbound_tx, outbound_rx, closed)
    }

    #[tokio::test]
    async fn connection_session_hello_gate_auth_accept() {
        // No token configured → any hello is accepted.
        let env = test_env();
        let (transport, inbound_tx, mut outbound_rx, closed) = in_mem_split();
        let session = ConnectionSession::new(transport, env);
        let handle = tokio::spawn(async move { session.run().await });

        // Send hello.
        inbound_tx
            .send(Some(ClientMessage::Hello {
                auth: None,
                resume: None,
            }))
            .await
            .unwrap();
        // Close the inbound channel so recv returns None → session tears down.
        inbound_tx.send(None).await.unwrap();

        // The session should have sent a Hello back (the hub's add_client sends it).
        let mut got_hello = false;
        while let Ok(msg) =
            tokio::time::timeout(Duration::from_millis(500), outbound_rx.recv()).await
        {
            if matches!(msg, Some(ServerMessage::Hello { .. })) {
                got_hello = true;
                break;
            }
        }
        assert!(
            got_hello,
            "session must send a Hello back on successful auth"
        );

        // Session exits cleanly.
        tokio::time::timeout(Duration::from_secs(2), handle)
            .await
            .expect("session did not exit")
            .expect("session task panicked");
        assert!(
            closed.load(std::sync::atomic::Ordering::SeqCst),
            "transport close() must be called on teardown"
        );
    }

    #[tokio::test]
    async fn connection_session_hello_gate_auth_reject() {
        // Token configured → a hello without it is rejected.
        let mut env = test_env();
        env.config = Arc::new(Config {
            token: Some("secret".into()),
            ..(*env.config).clone()
        });
        let (transport, inbound_tx, _outbound_rx, closed) = in_mem_split();
        let session = ConnectionSession::new(transport, env);
        let handle = tokio::spawn(async move { session.run().await });

        // Hello with wrong token → session should close and exit.
        inbound_tx
            .send(Some(ClientMessage::Hello {
                auth: Some("wrong".into()),
                resume: None,
            }))
            .await
            .unwrap();

        tokio::time::timeout(Duration::from_secs(2), handle)
            .await
            .expect("session did not exit on auth failure")
            .expect("session task panicked");
        assert!(
            closed.load(std::sync::atomic::Ordering::SeqCst),
            "transport must be closed on auth failure"
        );
    }

    #[tokio::test]
    async fn connection_session_rejects_non_hello_first_message() {
        let env = test_env();
        let (transport, inbound_tx, _outbound_rx, closed) = in_mem_split();
        let session = ConnectionSession::new(transport, env);
        let handle = tokio::spawn(async move { session.run().await });

        // First message is not hello → reject.
        inbound_tx.send(Some(ClientMessage::Ping)).await.unwrap();

        tokio::time::timeout(Duration::from_secs(2), handle)
            .await
            .expect("session did not exit on non-hello first message")
            .expect("session task panicked");
        assert!(
            closed.load(std::sync::atomic::Ordering::SeqCst),
            "transport must be closed on non-hello first message"
        );
    }

    #[tokio::test]
    async fn connection_session_ping_pong_routing() {
        // A Ping after hello must produce a Pong (routed through the hub's
        // handle_client → send_to_client → pump → transport).
        let env = test_env();
        let (transport, inbound_tx, mut outbound_rx, _closed) = in_mem_split();
        let session = ConnectionSession::new(transport, env);
        let handle = tokio::spawn(async move { session.run().await });

        inbound_tx
            .send(Some(ClientMessage::Hello {
                auth: None,
                resume: None,
            }))
            .await
            .unwrap();

        // Wait for the hub's Hello to arrive.
        loop {
            match tokio::time::timeout(Duration::from_millis(500), outbound_rx.recv()).await {
                Ok(Some(ServerMessage::Hello { .. })) => break,
                Ok(Some(_)) => continue,
                Ok(None) => panic!("transport closed before hello"),
                Err(_) => panic!("timeout waiting for hello"),
            }
        }

        // Now send a Ping.
        inbound_tx.send(Some(ClientMessage::Ping)).await.unwrap();

        // Expect a Pong (possibly after other connect-list messages).
        let mut got_pong = false;
        for _ in 0..50 {
            match tokio::time::timeout(Duration::from_millis(500), outbound_rx.recv()).await {
                Ok(Some(ServerMessage::Pong)) => {
                    got_pong = true;
                    break;
                }
                Ok(Some(_)) => continue,
                Ok(None) => break,
                Err(_) => break,
            }
        }
        assert!(got_pong, "session must route Ping → Pong through the hub");

        // Teardown.
        inbound_tx.send(None).await.unwrap();
        let _ = tokio::time::timeout(Duration::from_secs(2), handle).await;
    }

    #[tokio::test]
    async fn connection_session_cleanup_on_eof() {
        // On transport EOF (recv returns None), the client must be removed
        // from the hub (client_count returns to 0).
        let env = test_env();
        let hub = env.hub.clone();
        let (transport, inbound_tx, _outbound_rx, _closed) = in_mem_split();
        let session = ConnectionSession::new(transport, env);
        let handle = tokio::spawn(async move { session.run().await });

        inbound_tx
            .send(Some(ClientMessage::Hello {
                auth: None,
                resume: None,
            }))
            .await
            .unwrap();

        // Wait until the hub has a client.
        for _ in 0..40 {
            if hub.lock().client_count() > 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert_eq!(
            hub.lock().client_count(),
            1,
            "hub must have one client after hello"
        );

        // Close inbound → recv returns None → session tears down + removes client.
        inbound_tx.send(None).await.unwrap();
        let _ = tokio::time::timeout(Duration::from_secs(2), handle).await;

        for _ in 0..40 {
            if hub.lock().client_count() == 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("hub must have no clients after EOF cleanup");
    }
}
