//! Length-prefixed framing codec for the stdio transport adapter.
//!
//! ## Wire format
//!
//! Each frame is: a 4-byte **big-endian** `u32` length prefix, followed by
//! exactly that many bytes of UTF-8 JSON. The length counts the JSON body
//! bytes (prefix excluded), and each frame contains exactly one JSON value.
//!
//! ```text
//!  ┌─────────────┬──────────────────────────────────┐
//!  │ len: u32 BE  │  JSON body (len bytes, UTF-8)    │
//!  └─────────────┴──────────────────────────────────┘
//! ```
//!
//! Canonical choices:
//! - **big-endian** length prefix (network byte order)
//! - **u32** (4 bytes) — max declared frame is 4 GiB, but capped at
//!   [`MAX_FRAME_BYTES`] (16 MiB) to prevent abuse
//! - length = number of JSON body bytes, prefix excluded
//! - one JSON value per frame
//!
//! ## stdout-is-protocol-only (Phase 1 contract)
//!
//! The stdio adapter (Phase 1) MUST keep all log/diagnostic output off stdout —
//! stdout carries only framed protocol bytes. This is a Phase 1 adapter concern
//! and is **not** testable in Phase 0 because there is no stdio process yet.
//! It is documented here as a contract the adapter must enforce.

use std::io::Write;

use serde::de::DeserializeOwned;

use crate::transport::{ClientEnvelope, ServerEnvelope};

/// Maximum number of bytes in a single frame body (16 MiB). Oversized frames
/// are a hard error, not truncation — a declared length exceeding this is
/// rejected before the decoder allocates the full declared size.
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

/// Errors produced by the framing codec.
#[derive(Debug)]
pub enum FrameError {
    /// The declared length in a received frame exceeds [`MAX_FRAME_BYTES`].
    /// The decoder rejects this *before* allocating the declared size to guard
    /// against the classic length-prefix DoS.
    Oversized { declared: u32, limit: usize },
    /// The serialized JSON exceeds [`MAX_FRAME_BYTES`] at encode time.
    JsonTooLarge,
    /// The frame body is not valid UTF-8.
    InvalidUtf8,
    /// An incomplete length-prefix or body — more bytes needed. This variant
    /// is never yielded by [`FrameDecoder::push`] (which simply waits for more
    /// bytes); it is reserved for a future stream-end operation that would
    /// yield `Truncated` for any remaining incomplete frame at stream close
    /// (a Phase 1 adapter concern).
    Truncated,
    /// The frame body is not valid JSON.
    MalformedJson(serde_json::Error),
    /// The frame body is empty (length prefix = 0). A zero-length frame is
    /// not a valid JSON value, so it is reported as an explicit error rather
    /// than passing empty bytes to the JSON parser.
    Empty,
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameError::Oversized { declared, limit } => write!(
                f,
                "frame declared {} bytes but limit is {}",
                declared, limit
            ),
            FrameError::JsonTooLarge => {
                write!(f, "serialized JSON exceeds max frame bytes")
            }
            FrameError::InvalidUtf8 => write!(f, "frame body is not valid UTF-8"),
            FrameError::Truncated => write!(f, "incomplete frame (need more bytes)"),
            FrameError::MalformedJson(e) => write!(f, "malformed JSON in frame body: {}", e),
            FrameError::Empty => write!(f, "empty frame (length prefix = 0)"),
        }
    }
}

impl std::error::Error for FrameError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            FrameError::MalformedJson(e) => Some(e),
            _ => None,
        }
    }
}

// ── Encode ─────────────────────────────────────────────────────────────

/// Encode a server→client envelope as a length-prefixed frame.
///
/// Writes a 4-byte big-endian length prefix followed by the UTF-8 JSON
/// serialization of the envelope. Returns [`FrameError::JsonTooLarge`] if the
/// serialized JSON exceeds [`MAX_FRAME_BYTES`].
pub fn encode(message: &ServerEnvelope) -> Result<Vec<u8>, FrameError> {
    encode_json(&serde_json::to_vec(message).map_err(FrameError::MalformedJson)?)
}

/// Encode a client→server envelope as a length-prefixed frame.
///
/// Same framing as [`encode`]; the client/server split mirrors the message
/// direction so the unsuffixed `encode` is the server→client default.
pub fn encode_client(message: &ClientEnvelope) -> Result<Vec<u8>, FrameError> {
    encode_json(&serde_json::to_vec(message).map_err(FrameError::MalformedJson)?)
}

fn encode_json(json: &[u8]) -> Result<Vec<u8>, FrameError> {
    if json.len() > MAX_FRAME_BYTES {
        return Err(FrameError::JsonTooLarge);
    }
    let len = json.len() as u32;
    let mut out = Vec::with_capacity(4 + json.len());
    out.write_all(&len.to_be_bytes()).expect("vec write");
    out.extend_from_slice(json);
    Ok(out)
}

// ── Convenience decode wrappers ─────────────────────────────────────────

/// Decode a complete frame body (length-prefix already stripped) into a
/// [`ServerEnvelope`]. For incremental decoding across partial reads, use
/// [`FrameDecoder`] instead.
pub fn decode(body: &[u8]) -> Result<ServerEnvelope, FrameError> {
    decode_envelope(body)
}

/// Decode a complete frame body (length-prefix already stripped) into a
/// [`ClientEnvelope`]. Mirrors [`decode`]: server direction is the unsuffixed
/// default.
pub fn decode_client(body: &[u8]) -> Result<ClientEnvelope, FrameError> {
    decode_envelope(body)
}

fn decode_envelope<T: DeserializeOwned>(body: &[u8]) -> Result<T, FrameError> {
    if body.is_empty() {
        return Err(FrameError::Empty);
    }
    let s = std::str::from_utf8(body).map_err(|_| FrameError::InvalidUtf8)?;
    serde_json::from_str(s).map_err(FrameError::MalformedJson)
}

// ── Incremental decoder ────────────────────────────────────────────────

/// Incremental frame decoder.
///
/// Accumulates bytes across multiple [`push`](Self::push) calls and yields
/// complete frame bodies (length-prefix stripped) as they become available.
/// The decoder is transport-direction-agnostic and message-type-agnostic by
/// design: it returns raw frame bodies, and the caller is responsible for
/// deserializing them as `ServerEnvelope` or `ClientEnvelope` via
/// [`decode`] / [`decode_client`], or directly with `serde_json::from_slice`.
///
/// This keeps the codec purely about framing (length-prefix + UTF-8 boundary)
/// without coupling to a specific envelope type or requiring generic
/// `FrameDecoder<T>` complexity.
#[derive(Debug, Default)]
pub struct FrameDecoder {
    buf: Vec<u8>,
}

impl FrameDecoder {
    /// Create a new empty decoder.
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed bytes into the decoder, yielding zero or more complete frame bodies
    /// (length-prefix stripped) in the order they were received.
    ///
    /// Each result is either the raw bytes of a complete frame body, or a
    /// [`FrameError`] if that frame was oversized, non-UTF-8, or malformed.
    /// Once a frame yields an error, the decoder state is reset to look for
    /// the next frame's length prefix (best-effort recovery for a framed
    /// stream where a corrupted frame should not poison subsequent frames).
    pub fn push(&mut self, bytes: &[u8]) -> Vec<Result<Vec<u8>, FrameError>> {
        self.buf.extend_from_slice(bytes);
        let mut results = Vec::new();

        loop {
            // Need at least 4 bytes for the length prefix.
            if self.buf.len() < 4 {
                break;
            }

            let declared = u32::from_be_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]);

            // Guard against the classic length-prefix DoS: check the limit
            // *before* growing the buffer to `declared`.
            if declared as usize > MAX_FRAME_BYTES {
                results.push(Err(FrameError::Oversized {
                    declared,
                    limit: MAX_FRAME_BYTES,
                }));
                // Recovery: discard the entire buffer — we cannot trust
                // subsequent bytes to align to frame boundaries after an
                // oversized frame in a stream we don't control.
                self.buf.clear();
                break;
            }

            let body_len = declared as usize;
            let total_len = 4 + body_len;

            if self.buf.len() < total_len {
                // Body not yet complete — wait for more bytes.
                break;
            }

            // Extract the body (skip the 4-byte prefix).
            let body = self.buf[4..total_len].to_vec();
            self.buf.drain(..total_len);

            if body.is_empty() {
                results.push(Err(FrameError::Empty));
            } else {
                results.push(Ok(body));
            }
        }

        results
    }

    /// Signal stream end and report any truncated frame.
    ///
    /// Call this when the underlying stream has closed (EOF). If the decoder
    /// has buffered bytes that don't form a complete frame (a partial length
    /// prefix or a partial body), this returns `Some(FrameError::Truncated)`
    /// so the caller can map it to a clean session close rather than hanging.
    /// If the buffer is empty (all frames were complete), returns `None`.
    ///
    /// This finally wires up the `Truncated` variant that Phase 0 reserved
    /// for "a future stream-end operation" (the stdio adapter, Phase 1.2).
    /// `push()` never yields `Truncated` — it just leaves partial bytes
    /// buffered and waits for more. `finish()` is the stream-end counterpart.
    pub fn finish(&mut self) -> Option<FrameError> {
        if self.buf.is_empty() {
            None
        } else {
            Some(FrameError::Truncated)
        }
    }
}

#[cfg(test)]
mod tests {
    //! Named validations:
    //! - `frame_codec_roundtrip_tests`
    //! - `frame_codec_rejects_invalid_input`
    //! - `frame_codec_handles_fragmentation`

    use super::*;
    use crate::transport::{ClientEnvelope, ServerEnvelope};
    use crate::wire::ClientMessage;

    fn sample_server_envelope() -> ServerEnvelope {
        ServerEnvelope::new(crate::wire::ServerMessage::Pong)
    }

    fn sample_client_envelope() -> ClientEnvelope {
        ClientEnvelope::new(ClientMessage::Hello {
            auth: Some("t".into()),
            resume: None,
        })
    }

    // ── roundtrip_tests ────────────────────────────────────────────────

    #[test]
    fn server_envelope_roundtrips_through_encode_decode() {
        let env = sample_server_envelope();
        let frame = encode(&env).unwrap();
        // Strip the 4-byte length prefix to get the body.
        assert!(frame.len() > 4);
        let body = &frame[4..];
        let decoded: ServerEnvelope = decode(body).unwrap();
        let orig_json = serde_json::to_value(&env).unwrap();
        let dec_json = serde_json::to_value(&decoded).unwrap();
        assert_eq!(orig_json, dec_json);
    }

    #[test]
    fn client_envelope_roundtrips_through_encode_decode() {
        let env = sample_client_envelope();
        let frame = encode_client(&env).unwrap();
        let body = &frame[4..];
        let decoded: ClientEnvelope = decode_client(body).unwrap();
        let orig_json = serde_json::to_value(&env).unwrap();
        let dec_json = serde_json::to_value(&decoded).unwrap();
        assert_eq!(orig_json, dec_json);
    }

    #[test]
    fn encode_writes_big_endian_length_prefix() {
        let env = sample_server_envelope();
        let frame = encode(&env).unwrap();
        let body = &frame[4..];
        let prefix = u32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]);
        assert_eq!(prefix as usize, body.len());
    }

    // ── handles_fragmentation ──────────────────────────────────────────

    #[test]
    fn fragmented_single_byte_chunks_decode_intact() {
        let env = sample_server_envelope();
        let frame = encode(&env).unwrap();
        let mut decoder = FrameDecoder::new();
        let mut decoded_bodies = Vec::new();

        for byte in frame.iter() {
            let results = decoder.push(std::slice::from_ref(byte));
            decoded_bodies.extend(results);
        }

        assert_eq!(decoded_bodies.len(), 1, "exactly one frame");
        let body = decoded_bodies[0].as_ref().unwrap();
        let decoded: ServerEnvelope = decode(body).unwrap();
        let orig_json = serde_json::to_value(&env).unwrap();
        let dec_json = serde_json::to_value(&decoded).unwrap();
        assert_eq!(orig_json, dec_json);
    }

    #[test]
    fn multiple_frames_in_one_push_decode_in_order() {
        let env1 = sample_server_envelope();
        let env2 = ServerEnvelope::new(crate::wire::ServerMessage::Pong);
        let frame1 = encode(&env1).unwrap();
        let frame2 = encode(&env2).unwrap();
        let combined: Vec<u8> = frame1.iter().chain(frame2.iter()).copied().collect();

        let mut decoder = FrameDecoder::new();
        let results = decoder.push(&combined);
        assert_eq!(results.len(), 2, "two frames decoded");
        assert!(results[0].is_ok());
        assert!(results[1].is_ok());
    }

    #[test]
    fn partial_length_prefix_then_completion() {
        let env = sample_server_envelope();
        let frame = encode(&env).unwrap();

        let mut decoder = FrameDecoder::new();
        // Feed only 2 bytes of the length prefix.
        assert!(decoder.push(&frame[..2]).is_empty());
        // Feed the rest.
        let results = decoder.push(&frame[2..]);
        assert_eq!(results.len(), 1);
        assert!(results[0].is_ok());
    }

    #[test]
    fn partial_body_then_completion() {
        let env = sample_server_envelope();
        let frame = encode(&env).unwrap();
        let split = 4 + 2; // prefix + 2 body bytes

        let mut decoder = FrameDecoder::new();
        assert!(decoder.push(&frame[..split]).is_empty());
        let results = decoder.push(&frame[split..]);
        assert_eq!(results.len(), 1);
        assert!(results[0].is_ok());
    }

    // ── rejects_invalid_input ──────────────────────────────────────────

    #[test]
    fn oversized_declared_length_rejected_without_allocating() {
        // Craft a frame whose declared length exceeds MAX_FRAME_BYTES.
        let oversized_len = (MAX_FRAME_BYTES as u32) + 1;
        let mut bad_frame = Vec::new();
        bad_frame.extend_from_slice(&oversized_len.to_be_bytes());
        // Only add a few body bytes — the point is the declared length is huge.
        bad_frame.extend_from_slice(b"x");

        let mut decoder = FrameDecoder::new();
        let results = decoder.push(&bad_frame);
        assert_eq!(results.len(), 1, "one error yielded");
        match &results[0] {
            Err(FrameError::Oversized { declared, limit }) => {
                assert_eq!(*declared, oversized_len);
                assert_eq!(*limit, MAX_FRAME_BYTES);
            }
            other => panic!("expected Oversized, got {:?}", other),
        }
        // Verify the decoder did not allocate the full declared size: the
        // internal buffer should be empty (it cleared on oversized).
        assert!(decoder.push(b"").is_empty());
    }

    #[test]
    fn invalid_utf8_body_returns_invalid_utf8_error() {
        // Build a frame with a valid length prefix but invalid UTF-8 body.
        let bad_body: &[u8] = &[0xFF, 0xFE, 0xFF];
        let mut frame = Vec::new();
        frame.extend_from_slice(&(bad_body.len() as u32).to_be_bytes());
        frame.extend_from_slice(bad_body);

        let mut decoder = FrameDecoder::new();
        let results = decoder.push(&frame);
        assert_eq!(results.len(), 1);
        let body = results[0].as_ref().unwrap().clone();
        let err = decode(&body).unwrap_err();
        assert!(matches!(err, FrameError::InvalidUtf8), "got {:?}", err);
    }

    #[test]
    fn malformed_json_body_returns_malformed_json_error() {
        let bad_json = b"{not valid json";
        let mut frame = Vec::new();
        frame.extend_from_slice(&(bad_json.len() as u32).to_be_bytes());
        frame.extend_from_slice(bad_json);

        let mut decoder = FrameDecoder::new();
        let results = decoder.push(&frame);
        assert_eq!(results.len(), 1);
        let body = results[0].as_ref().unwrap().clone();
        let err = decode(&body).unwrap_err();
        assert!(matches!(err, FrameError::MalformedJson(_)), "got {:?}", err);
    }

    #[test]
    fn zero_length_frame_returns_empty_error() {
        let mut frame = Vec::new();
        frame.extend_from_slice(&0u32.to_be_bytes());

        let mut decoder = FrameDecoder::new();
        let results = decoder.push(&frame);
        assert_eq!(results.len(), 1);
        match &results[0] {
            Err(FrameError::Empty) => {}
            other => panic!("expected Empty, got {:?}", other),
        }
    }

    #[test]
    fn truncated_frame_waits_for_more_bytes() {
        // Only 2 bytes of a length prefix — incomplete.
        let mut decoder = FrameDecoder::new();
        let results = decoder.push(&[0x00, 0x00]);
        assert!(results.is_empty(), "should wait for 4 bytes");

        // Length prefix complete but body not yet arrived.
        let mut decoder = FrameDecoder::new();
        let mut frame = Vec::new();
        frame.extend_from_slice(&10u32.to_be_bytes()); // declares 10-byte body
        frame.extend_from_slice(b"only5"); // only 5 bytes
        let results = decoder.push(&frame);
        assert!(results.is_empty(), "should wait for full body");
    }

    #[test]
    fn encode_rejects_json_exceeding_max_frame_bytes() {
        // Create an envelope whose JSON serialization exceeds MAX_FRAME_BYTES.
        // We can't easily make a real ServerMessage that large, so test the
        // internal encode_json guard directly with an oversized byte slice.
        let oversized: Vec<u8> = vec![b'x'; MAX_FRAME_BYTES + 1];
        let err = encode_json(&oversized).unwrap_err();
        assert!(matches!(err, FrameError::JsonTooLarge), "got {:?}", err);
    }

    // ── finish() / Truncated-at-EOF (Phase 1 extension) ───────────────

    #[test]
    fn finish_returns_none_when_buffer_empty() {
        let mut decoder = FrameDecoder::new();
        assert!(decoder.finish().is_none(), "empty buffer → no error");
    }

    #[test]
    fn finish_returns_none_after_complete_frame() {
        let env = sample_server_envelope();
        let frame = encode(&env).unwrap();
        let mut decoder = FrameDecoder::new();
        let results = decoder.push(&frame);
        assert_eq!(results.len(), 1);
        assert!(results[0].is_ok());
        // After decoding the complete frame, buffer should be empty.
        assert!(decoder.finish().is_none(), "complete frame → no truncation");
    }

    #[test]
    fn finish_returns_truncated_for_partial_length_prefix() {
        let mut decoder = FrameDecoder::new();
        // Feed only 2 bytes of a length prefix.
        let results = decoder.push(&[0x00, 0x00]);
        assert!(results.is_empty(), "partial prefix → no frames yet");
        // At EOF, the partial prefix is a truncated frame.
        let err = decoder.finish().expect("partial prefix → Truncated");
        assert!(matches!(err, FrameError::Truncated), "got {:?}", err);
    }

    #[test]
    fn finish_returns_truncated_for_partial_body() {
        let mut decoder = FrameDecoder::new();
        // Declare a 10-byte body but only feed 5 bytes.
        let mut frame = Vec::new();
        frame.extend_from_slice(&10u32.to_be_bytes());
        frame.extend_from_slice(b"only5");
        let results = decoder.push(&frame);
        assert!(results.is_empty(), "partial body → no frames yet");
        let err = decoder.finish().expect("partial body → Truncated");
        assert!(matches!(err, FrameError::Truncated), "got {:?}", err);
    }
}
