//! Framed-stdio transport adapter over [`ConnectionSession`].
//!
//! Implements the same `Transport` + `TransportSplit` contract as the WS
//! adapter, but over `tokio::io::{stdin, stdout}` using the Phase 0
//! length-prefixed frame codec. The session speaks raw logical messages
//! (`ClientMessage`/`ServerMessage`); this adapter wraps/unwraps the
//! `WireEnvelope` at the transport boundary — per the operator-confirmed
//! Option A, the envelope+frame is a **stdio-only** wire concern, and the
//! session is never exposed to it.
//!
//! ## stdout-is-protocol-only (AC.2)
//!
//! All `tracing`/diagnostic output goes to stderr. stdout carries only framed
//! protocol bytes. The caller is responsible for ensuring the tracing
//! subscriber writes to stderr (the default `tracing_subscriber::fmt()` does).
//!
//! ## Backpressure
//!
//! The outbound pump awaits each stdout write; if stdout blocks, the hub's
//! channel (buffer 128) provides natural backpressure. No unbounded writers.
//!
//! ## Half-close / EOF
//!
//! On stdin EOF mid-frame, `FrameDecoder::finish()` returns
//! `Some(FrameError::Truncated)` — the adapter maps this to a clean session
//! close (returns `None` from `recv`), wiring up the variant Phase 0 reserved
//! for this.

use std::io;

use async_trait::async_trait;
use pantoken_protocol::frame::{self, FrameDecoder, FrameError};
use pantoken_protocol::transport::{ClientEnvelope, ServerEnvelope};
use pantoken_protocol::wire::{ClientMessage, ServerMessage};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tracing::warn;

use crate::connection::{Transport, TransportRead, TransportSplit, TransportWrite};

/// A framed-stdio adapter implementing [`Transport`] (pre-split, for the hello
/// gate) and [`TransportSplit`] (split into reader/writer for the pump + inbound
/// loop).
///
/// Generic over the read and write halves so tests can substitute in-memory
/// pipes. The production path uses `tokio::io::stdin()` + `tokio::io::stdout()`.
pub struct StdioAdapter<
    R: AsyncReadExt + Unpin + Send + 'static,
    W: AsyncWriteExt + Unpin + Send + 'static,
> {
    stdin: R,
    stdout: W,
}

impl<R: AsyncReadExt + Unpin + Send + 'static, W: AsyncWriteExt + Unpin + Send + 'static>
    StdioAdapter<R, W>
{
    pub fn new(stdin: R, stdout: W) -> Self {
        Self { stdin, stdout }
    }
}

#[async_trait]
impl<R: AsyncReadExt + Unpin + Send + 'static, W: AsyncWriteExt + Unpin + Send + 'static> Transport
    for StdioAdapter<R, W>
{
    async fn recv(&mut self) -> Option<ClientMessage> {
        let mut decoder = FrameDecoder::new();
        let mut buf = [0u8; 8192];
        loop {
            match self.stdin.read(&mut buf).await {
                Ok(0) => {
                    // EOF — check for a truncated frame.
                    if let Some(err) = decoder.finish() {
                        warn!("stdio transport EOF with truncated frame: {err}");
                    }
                    return None;
                }
                Ok(n) => {
                    for result in decoder.push(&buf[..n]) {
                        match result {
                            Ok(body) => match frame::decode_client(&body) {
                                Ok(env) => return Some(env.message),
                                Err(e) => {
                                    warn!("stdio frame decode error: {e}");
                                    continue;
                                }
                            },
                            Err(e) => {
                                warn!("stdio frame error: {e}");
                                // The decoder resets on error (best-effort
                                // recovery); continue reading.
                                continue;
                            }
                        }
                    }
                }
                Err(e) => {
                    warn!("stdio read error: {e}");
                    return None;
                }
            }
        }
    }

    async fn send(&mut self, msg: ServerMessage) -> bool {
        let env = ServerEnvelope::new(msg);
        match frame::encode(&env) {
            Ok(frame_bytes) => {
                if let Err(e) = self.stdout.write_all(&frame_bytes).await {
                    warn!("stdio write error: {e}");
                    return false;
                }
                // Flush to ensure prompt delivery (the session's heartbeat
                // watchdog treats any inbound frame as proof of life).
                if let Err(e) = self.stdout.flush().await {
                    warn!("stdio flush error: {e}");
                    return false;
                }
                true
            }
            Err(e) => {
                warn!("stdio frame encode error: {e}");
                false
            }
        }
    }

    async fn close(&mut self) {
        // Flush stdout on close; the OS will close the fds on process exit.
        let _ = self.stdout.flush().await;
    }
}

impl<R: AsyncReadExt + Unpin + Send + 'static, W: AsyncWriteExt + Unpin + Send + 'static>
    TransportSplit for StdioAdapter<R, W>
{
    type Reader = StdioReader<R>;
    type Writer = StdioWriter<W>;

    fn split(self) -> (Self::Reader, Self::Writer) {
        (
            StdioReader {
                stdin: self.stdin,
                decoder: FrameDecoder::new(),
            },
            StdioWriter {
                stdout: self.stdout,
            },
        )
    }
}

/// The read half of a split stdio adapter. Owns the `FrameDecoder` state so
/// partial frames survive across reads.
pub struct StdioReader<R: AsyncReadExt + Unpin + Send + 'static> {
    stdin: R,
    decoder: FrameDecoder,
}

#[async_trait]
impl<R: AsyncReadExt + Unpin + Send + 'static> TransportRead for StdioReader<R> {
    async fn recv(&mut self) -> Option<ClientMessage> {
        let mut buf = [0u8; 8192];
        loop {
            // First, drain any frames the decoder already has buffered from
            // a previous push (a single read may have contained multiple frames).
            // This is handled by the push loop below — we don't drain here
            // because push returns all complete frames from the new bytes.
            match self.stdin.read(&mut buf).await {
                Ok(0) => {
                    // EOF — check for a truncated frame.
                    if let Some(err) = self.decoder.finish() {
                        warn!("stdio transport EOF with truncated frame: {err}");
                    }
                    return None;
                }
                Ok(n) => {
                    for result in self.decoder.push(&buf[..n]) {
                        match result {
                            Ok(body) => match frame::decode_client(&body) {
                                Ok(env) => return Some(env.message),
                                Err(e) => {
                                    warn!("stdio frame decode error: {e}");
                                    continue;
                                }
                            },
                            Err(e) => {
                                warn!("stdio frame error: {e}");
                                continue;
                            }
                        }
                    }
                }
                Err(e) => {
                    warn!("stdio read error: {e}");
                    return None;
                }
            }
        }
    }
}

/// The write half of a split stdio adapter. Owns the stdout sink.
pub struct StdioWriter<W: AsyncWriteExt + Unpin + Send + 'static> {
    stdout: W,
}

#[async_trait]
impl<W: AsyncWriteExt + Unpin + Send + 'static> TransportWrite for StdioWriter<W> {
    async fn send(&mut self, msg: ServerMessage) -> bool {
        let env = ServerEnvelope::new(msg);
        match frame::encode(&env) {
            Ok(frame_bytes) => {
                if let Err(e) = self.stdout.write_all(&frame_bytes).await {
                    warn!("stdio write error: {e}");
                    return false;
                }
                if let Err(e) = self.stdout.flush().await {
                    warn!("stdio flush error: {e}");
                    return false;
                }
                true
            }
            Err(e) => {
                warn!("stdio frame encode error: {e}");
                false
            }
        }
    }

    async fn close(&mut self) {
        let _ = self.stdout.flush().await;
    }
}

/// Construct a `StdioAdapter` over the process's real stdin/stdout.
///
/// This is the production entry point for the stdio-proxy / remote-runtime
/// mode. Diagnostics go to stderr (the tracing subscriber handles this).
pub fn process_stdio_adapter() -> StdioAdapter<tokio::io::Stdin, tokio::io::Stdout> {
    StdioAdapter::new(tokio::io::stdin(), tokio::io::stdout())
}

/// Encode a `ClientMessage` into a framed `ClientEnvelope` byte vector.
///
/// Utility for the bridge and tests that need to produce framed bytes on the
/// client side (wrapping raw logical messages into the stdio wire format).
pub fn encode_client_frame(msg: &ClientMessage) -> Result<Vec<u8>, FrameError> {
    frame::encode_client(&ClientEnvelope::new(msg.clone()))
}

/// Decode a framed `ServerEnvelope` body into a `ServerMessage`.
///
/// Utility for the bridge and tests that consume framed server bytes.
pub fn decode_server_frame(body: &[u8]) -> Result<ServerMessage, FrameError> {
    Ok(frame::decode(body)?.message)
}

/// A relay that forwards framed bytes bidirectionally between an async reader
/// (stdin) and an async writer (a Unix socket), and vice versa.
///
/// Used by the remote-proxy command mode (Phase 1.2): the proxy does NOT run
/// the hub — it connects to the persistent runtime's Unix socket and relays
/// framed bytes. This struct is the raw byte relay; the `ConnectionSession`
/// runs on the persistent runtime side.
pub struct FramedRelay<R1, W1, R2, W2>
where
    R1: AsyncReadExt + Unpin + Send,
    W1: AsyncWriteExt + Unpin + Send,
    R2: AsyncReadExt + Unpin + Send,
    W2: AsyncWriteExt + Unpin + Send,
{
    /// stdin → socket direction.
    pub left_read: R1,
    pub left_write: W1,
    /// socket → stdout direction.
    pub right_read: R2,
    pub right_write: W2,
}

impl<R1, W1, R2, W2> FramedRelay<R1, W1, R2, W2>
where
    R1: AsyncReadExt + Unpin + Send,
    W1: AsyncWriteExt + Unpin + Send,
    R2: AsyncReadExt + Unpin + Send,
    W2: AsyncWriteExt + Unpin + Send,
{
    /// Run the bidirectional relay until either direction EOFs or errors.
    ///
    /// Both directions run concurrently; when one closes, the other is
    /// flushed and the relay returns. This is a raw byte relay — it does
    /// not inspect or modify frame boundaries (the persistent runtime's
    /// `ConnectionSession` handles framing on its side of the socket).
    pub async fn run(mut self) -> io::Result<()> {
        // Box the futures so they can be awaited in select! without moving.
        let mut left_to_right = Box::pin(async {
            let mut buf = [0u8; 8192];
            loop {
                match self.left_read.read(&mut buf).await {
                    Ok(0) => break Ok(()),
                    Ok(n) => {
                        if let Err(e) = self.right_write.write_all(&buf[..n]).await {
                            break Err(e);
                        }
                        if let Err(e) = self.right_write.flush().await {
                            break Err(e);
                        }
                    }
                    Err(e) => break Err(e),
                }
            }
        });

        let mut right_to_left = Box::pin(async {
            let mut buf = [0u8; 8192];
            loop {
                match self.right_read.read(&mut buf).await {
                    Ok(0) => break Ok(()),
                    Ok(n) => {
                        if let Err(e) = self.left_write.write_all(&buf[..n]).await {
                            break Err(e);
                        }
                        if let Err(e) = self.left_write.flush().await {
                            break Err(e);
                        }
                    }
                    Err(e) => break Err(e),
                }
            }
        });

        // Race both directions; when one finishes, return.
        // We can't await the loser after select! (it's been moved), so we
        // just return the winner's result. The loser is dropped (its I/O
        // halves were already moved into it).
        tokio::select! {
            result = &mut left_to_right => result,
            result = &mut right_to_left => result,
        }
    }
}

#[cfg(test)]
mod tests {
    //! Named validations (unit level):
    //! - `stdio_adapter_frame_fragmentation`
    //! - `stdio_adapter_oversized_rejected`
    //! - `stdio_adapter_truncated_at_eof`
    //! - `stdio_adapter_stdout_is_protocol_only` (integration test in tests/)
    //!
    //! The `stdio_stdout_is_protocol_only` integration test (spawning a real
    //! stdio process and capturing stdout/stderr separately) lives in
    //! `tests/stdio_adapter_contract_tests.rs`.

    use super::*;
    use pantoken_protocol::wire::ClientMessage;
    use tokio::io::{AsyncReadExt, duplex};

    /// Build a framed client hello message.
    fn framed_hello() -> Vec<u8> {
        encode_client_frame(&ClientMessage::Hello {
            auth: Some("tok".into()),
            resume: None,
        })
        .unwrap()
    }

    #[tokio::test]
    async fn stdio_adapter_reads_complete_frame() {
        let frame = framed_hello();
        let (mut client, server) = duplex(4096);
        // Write a complete frame to the "stdin" side.
        client.write_all(&frame).await.unwrap();
        client.flush().await.unwrap();

        let mut adapter: StdioAdapter<_, _> = StdioAdapter::new(server, tokio::io::sink());
        let msg = adapter.recv().await.expect("must receive hello");
        match msg {
            ClientMessage::Hello { auth, .. } => {
                assert_eq!(auth, Some("tok".into()));
            }
            other => panic!("expected Hello, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn stdio_adapter_handles_fragmented_frame() {
        // Feed the frame one byte at a time — the decoder must accumulate
        // across reads and yield the complete frame.
        let frame = framed_hello();
        let (mut client, server) = duplex(4096);
        let adapter: StdioAdapter<_, _> = StdioAdapter::new(server, tokio::io::sink());
        let recv_task = tokio::spawn(async move {
            let mut adapter = adapter;
            adapter.recv().await
        });

        for byte in &frame {
            client.write_all(std::slice::from_ref(byte)).await.unwrap();
            client.flush().await.unwrap();
        }

        let msg = recv_task.await.unwrap().expect("must receive hello");
        assert!(matches!(msg, ClientMessage::Hello { .. }));
    }

    #[tokio::test]
    async fn stdio_adapter_truncated_at_eof() {
        // Feed a partial frame then close stdin — recv() must return None
        // (mapping Truncated to a clean close, not hanging).
        let mut partial = Vec::new();
        partial.extend_from_slice(&10u32.to_be_bytes()); // declares 10-byte body
        partial.extend_from_slice(b"only5"); // only 5 bytes

        let (mut client, server) = duplex(4096);
        client.write_all(&partial).await.unwrap();
        client.flush().await.unwrap();
        // Close the write side to simulate EOF.
        drop(client);

        let mut adapter: StdioAdapter<_, _> = StdioAdapter::new(server, tokio::io::sink());
        let result = tokio::time::timeout(std::time::Duration::from_secs(2), adapter.recv()).await;
        assert!(
            matches!(result, Ok(None)),
            "truncated frame at EOF must return None, got {result:?}"
        );
    }

    #[tokio::test]
    async fn stdio_adapter_oversized_declared_length_rejected() {
        // A frame declaring more than MAX_FRAME_BYTES should yield an error
        // (logged) and the adapter continues — but since the decoder clears
        // its buffer on oversized, the next read will try to resync. In
        // practice this returns None (stream is corrupt after oversized).
        let oversized_len = (frame::MAX_FRAME_BYTES as u32) + 1;
        let mut bad_frame = Vec::new();
        bad_frame.extend_from_slice(&oversized_len.to_be_bytes());
        bad_frame.extend_from_slice(b"x");

        let (mut client, server) = duplex(4096);
        client.write_all(&bad_frame).await.unwrap();
        client.flush().await.unwrap();
        drop(client);

        let mut adapter: StdioAdapter<_, _> = StdioAdapter::new(server, tokio::io::sink());
        // The oversized frame is rejected; then EOF → None.
        let result = adapter.recv().await;
        assert!(result.is_none(), "oversized frame → None (stream corrupt)");
    }

    #[tokio::test]
    async fn stdio_adapter_writes_framed_server_message() {
        let (client, mut server) = duplex(4096);
        let mut adapter: StdioAdapter<_, _> = StdioAdapter::new(tokio::io::empty(), client);
        let ok = adapter
            .send(pantoken_protocol::wire::ServerMessage::Pong)
            .await;
        assert!(ok, "send must succeed");
        // Drop the adapter to close the write side so read_to_end terminates.
        drop(adapter);

        // Read the framed output from the "stdout" side.
        let mut buf = Vec::new();
        server.read_to_end(&mut buf).await.unwrap();
        assert!(!buf.is_empty(), "must have written framed bytes");
        // Decode the frame.
        let body = &buf[4..];
        let env: ServerEnvelope = serde_json::from_slice(body).unwrap();
        assert!(matches!(
            env.message,
            pantoken_protocol::wire::ServerMessage::Pong
        ));
    }

    #[tokio::test]
    async fn stdio_adapter_split_reads_and_writes() {
        // Test the split path: StdioReader reads a frame, StdioWriter writes one.
        let frame = framed_hello();
        let (mut client, server) = duplex(4096);
        client.write_all(&frame).await.unwrap();
        client.flush().await.unwrap();

        let (mut reader, mut writer) = StdioAdapter::new(server, tokio::io::sink()).split();
        let msg = reader.recv().await.expect("must receive hello");
        assert!(matches!(msg, ClientMessage::Hello { .. }));
        // Writer should be able to send (to the sink).
        assert!(
            writer
                .send(pantoken_protocol::wire::ServerMessage::Pong)
                .await
        );
    }
}
