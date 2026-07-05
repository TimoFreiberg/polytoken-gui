//! Golden daemon corpus loader + canonicalization tests.
//!
//! See `server-rs/tests/corpus/0.4.0-unstable.7/README.md` for the format. The
//! correctness bar: every seed event in every scenario's `sse[]` MUST deserialize
//! into the real `pilot_daemon_types::SseEnvelope` / `DaemonEvent` — the loader test
//! enforces this, so a daemon event-shape drift fails loud (no silent fallbacks).
//!
//! Canonicalization is idempotent: running it on already-canonical data yields
//! identical output. The seed fixtures ship pre-canonicalized; the capture script
//! canonicalizes real captures before writing. The test asserts replay
//! determinism by running canonicalization twice and comparing.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use pilot_daemon_types::SseEnvelope;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Resolve the corpus root: `<crate>/../tests/corpus` (i.e. `server-rs/tests/corpus`).
const CORPUS_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/corpus");

// ---------------------------------------------------------------------------
// Scenario file structs (mirror the JSON shape documented in the README)
// ---------------------------------------------------------------------------

/// The `canonicalization` manifest block of a scenario file.
///
/// `prompt_ids` is a `BTreeMap` (not `HashMap`) so serialization is deterministic
/// — the idempotency test compares pretty-printed JSON, and a `HashMap`'s
/// arbitrary iteration order would make two identical maps serialize differently.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct CanonicalizationManifest {
    session_id: String,
    prompt_ids: std::collections::BTreeMap<String, String>,
    timestamps: String,
}

/// One recorded HTTP request/response pair.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct HttpEntry {
    method: String,
    path: String,
    request_body: Option<Value>,
    status: i64,
    response_body: Option<Value>,
}

/// One SSE frame — the wire shape of a daemon `/events` `data:` payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SseFrame {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    seq: Option<i64>,
    emitted_at: String,
    session_id: String,
    event: Value,
}

/// A full scenario file.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ScenarioFile {
    scenario: String,
    version: String,
    #[allow(dead_code)]
    description: String,
    canonicalization: CanonicalizationManifest,
    http: Vec<HttpEntry>,
    sse: Vec<SseFrame>,
    expected_driver_events: Option<Value>,
}

// ---------------------------------------------------------------------------
// Canonicalization
//
// The seed fixtures ship pre-canonicalized, but real captures have raw session
// ids, prompt ids (UUIDs), and wall-clock timestamps. Canonicalization rewrites
// them to stable placeholders so a corpus replay is deterministic across runs.
//
//   session_id     → "SESSION"
//   prompt_id (UUID-like, not already a placeholder) → "PROMPT_0", "PROMPT_1", … (first-seen order)
//   timestamps     → monotonic epoch starting 1970-01-01T00:00:00.000Z, +1s per frame
//
// Idempotency: a value already matching a placeholder (`SESSION`, `PROMPT_\d+`,
// or the monotonic epoch) is left untouched, so re-running on canonicalized
// data is a no-op. The test asserts this.
// ---------------------------------------------------------------------------

/// A UUID-shaped string: 8-4-4-4-12 hex digits, dashes at positions 8/13/18/23.
fn looks_like_uuid(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    // Dashes at the canonical positions.
    if bytes[8] != b'-' || bytes[13] != b'-' || bytes[18] != b'-' || bytes[23] != b'-' {
        return false;
    }
    // Every non-dash byte is a hex digit.
    bytes
        .iter()
        .enumerate()
        .all(|(i, &b)| matches!(i, 8 | 13 | 18 | 23) || b.is_ascii_hexdigit())
}

/// True if `s` is already a canonical prompt placeholder (`PROMPT_N`).
fn is_prompt_placeholder(s: &str) -> bool {
    s.starts_with("PROMPT_") && s[7..].chars().all(|c| c.is_ascii_digit()) && s.len() > 7
}

/// True if `s` is the canonical session placeholder.
fn is_session_placeholder(s: &str) -> bool {
    s == "SESSION"
}

/// True if `s` is a canonical monotonic-epoch timestamp (`1970-01-01T00:00:0N.000Z`).
fn is_monotonic_epoch(s: &str) -> bool {
    s.starts_with("1970-01-01T00:00:") && s.ends_with(".000Z") && s.len() == 24
}

/// The canonicalization state: the session-id map and the prompt-id map built
/// during a canonicalize pass. Owned by `canonicalize_value`.
#[derive(Default)]
struct CanonState {
    /// Maps a real session id → "SESSION". (Single-session corpus; one placeholder.)
    session_ids: HashMap<String, String>,
    /// Maps a real prompt id → "PROMPT_N" in first-seen order.
    prompt_ids: HashMap<String, String>,
    /// Next PROMPT_N index to assign.
    next_prompt: usize,
}

impl CanonState {
    /// Map a session id to its placeholder, registering it if new.
    fn canon_session(&mut self, raw: &str) -> String {
        if is_session_placeholder(raw) {
            return raw.to_string();
        }
        self.session_ids
            .entry(raw.to_string())
            .or_insert_with(|| "SESSION".to_string())
            .clone()
    }

    /// Map a prompt id to its placeholder, registering it if new (first-seen order).
    fn canon_prompt(&mut self, raw: &str) -> String {
        if is_prompt_placeholder(raw) {
            return raw.to_string();
        }
        // Only UUID-shaped values are prompt ids; other opaque strings (call_id,
        // interrogative_id, item_id) are left as-is.
        if !looks_like_uuid(raw) {
            return raw.to_string();
        }
        let n = self.next_prompt;
        self.next_prompt += 1;
        let placeholder = format!("PROMPT_{}", n);
        self.prompt_ids.insert(raw.to_string(), placeholder.clone());
        placeholder
    }
}

/// Recursively walk a JSON value, rewriting session ids, prompt ids, and
/// timestamps in place. `prompt_keys` lists object keys whose string values are
/// prompt ids (so they get placeholder-mapped rather than left as opaque
/// strings). `session_keys` lists keys whose string values are session ids.
fn canonicalize_value(v: &mut Value, state: &mut CanonState) {
    match v {
        Value::Object(map) => {
            // Collect keys+values to mutate without borrowing map during iteration.
            let keys: Vec<String> = map.keys().cloned().collect();
            for key in keys {
                if let Some(child) = map.get_mut(&key) {
                    // Session-id key → the single "SESSION" placeholder (single-session
                    // corpus). Handles session_id wherever it's nested (event payloads,
                    // HTTP bodies), not just on the SSE envelope.
                    if key == "session_id" {
                        if let Value::String(s) = child {
                            *s = state.canon_session(s);
                        }
                        continue;
                    }
                    // Prompt-id key → PROMPT_N. `_prompt_id` (singular) covers
                    // prompt_id, admission_prompt_id, final_prompt_id, to_prompt_id, …
                    // Plural `_prompt_ids` arrays fall through to the recurse branch,
                    // where each bare UUID element is mapped by the String arm below.
                    let is_prompt_field = key == "prompt_id" || key.ends_with("_prompt_id");
                    if is_prompt_field {
                        if let Value::String(s) = child {
                            *s = state.canon_prompt(s);
                        }
                        continue;
                    }
                    // Arrays/objects: recurse.
                    if matches!(child, Value::Object(_) | Value::Array(_)) {
                        canonicalize_value(child, state);
                    }
                }
            }
        }
        Value::Array(arr) => {
            for child in arr.iter_mut() {
                canonicalize_value(child, state);
            }
        }
        Value::String(s)
            // A bare string that looks like a UUID could be a prompt id in an array
            // (e.g. admission_prompt_ids: ["<uuid>"]). Map it.
            if looks_like_uuid(s) =>
        {
            *s = state.canon_prompt(s);
        }
        _ => {}
    }
}

/// Canonicalize one SSE frame: rewrite the session_id, the emitted_at timestamp
/// to a monotonic epoch, and recursively rewrite ids inside `event`. `frame_idx`
/// seeds the monotonic timestamp (frame 0 → T0, frame N → T0+N seconds).
fn canonicalize_frame(frame: &mut SseFrame, frame_idx: usize, state: &mut CanonState) {
    // Session id on the envelope.
    frame.session_id = state.canon_session(&frame.session_id);

    // emitted_at → monotonic epoch, unless already canonical.
    if !is_monotonic_epoch(&frame.emitted_at) {
        frame.emitted_at = monotonic_timestamp(frame_idx);
    }

    // Recurse into the event payload.
    canonicalize_value(&mut frame.event, state);

    // The event's inner `timestamp` field (heartbeat / system_reminder carry one)
    // — rewrite to match the frame's emitted_at if not already canonical.
    if let Value::Object(map) = &mut frame.event {
        if let Some(Value::String(ts)) = map.get_mut("timestamp") {
            if !is_monotonic_epoch(ts) {
                *ts = monotonic_timestamp(frame_idx);
            }
        }
    }
}

/// Canonicalize the HTTP entries: rewrite session ids, prompt ids, and
/// timestamps inside request/response bodies.
fn canonicalize_http(http: &mut [HttpEntry], state: &mut CanonState) {
    for entry in http.iter_mut() {
        if let Some(body) = &mut entry.request_body {
            canonicalize_value(body, state);
        }
        if let Some(body) = &mut entry.response_body {
            canonicalize_value(body, state);
        }
    }
}

/// The Nth monotonic-epoch timestamp: `1970-01-01T00:00:0N.000Z`.
/// Caps the seconds at 59 to stay a valid wall-clock-ish value (a corpus with
/// 60+ frames is pathological; the capture script would need minute-rollover
/// logic, but that's a real-capture concern, not a seed-fixture one).
fn monotonic_timestamp(frame_idx: usize) -> String {
    let secs = frame_idx.min(59);
    format!("1970-01-01T00:00:{:02}.000Z", secs)
}

/// Canonicalize a full scenario in place: HTTP bodies + SSE frames. Idempotent.
fn canonicalize_scenario(scenario: &mut ScenarioFile) {
    let mut state = CanonState::default();
    canonicalize_http(&mut scenario.http, &mut state);
    for (idx, frame) in scenario.sse.iter_mut().enumerate() {
        canonicalize_frame(frame, idx, &mut state);
    }
}

// ---------------------------------------------------------------------------
// Corpus loading helpers
// ---------------------------------------------------------------------------

/// Enumerate every `.json` scenario file under `<corpus>/<version>/`, sorted for
/// deterministic test ordering. Fails loud if the version dir is missing.
fn scenario_files(version: &str) -> Vec<PathBuf> {
    let dir: PathBuf = PathBuf::from(CORPUS_DIR).join(version);
    assert!(
        dir.exists(),
        "corpus version dir missing: {}",
        dir.display()
    );
    let mut files: Vec<PathBuf> = fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("read corpus dir {}: {}", dir.display(), e))
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    files
}

/// Load + parse one scenario file. Fails loud on read/parse errors.
fn load_scenario(path: &PathBuf) -> ScenarioFile {
    let text =
        fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {}", path.display(), e));
    serde_json::from_str::<ScenarioFile>(&text)
        .unwrap_or_else(|e| panic!("parse {}: {}", path.display(), e))
}

/// The version dir(s) to test. New seed corpora ship under a versioned subdir;
/// this picks up every subdir under the corpus root.
fn version_dirs() -> Vec<String> {
    let root = PathBuf::from(CORPUS_DIR);
    assert!(root.exists(), "corpus root missing: {}", root.display());
    let mut dirs: Vec<String> = fs::read_dir(&root)
        .unwrap_or_else(|e| panic!("read corpus root {}: {}", root.display(), e))
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .filter_map(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.to_string())
        })
        .collect();
    dirs.sort();
    dirs
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// Loads EVERY scenario in every version dir, asserts each `sse[]` deserializes
/// into `Vec<SseEnvelope>` (the correctness bar — every seed event must parse
/// into the real enum), and that canonicalization is deterministic (running it
/// twice yields identical output — replay determinism).
#[test]
fn corpus_loads_and_canonicalizes() {
    let versions = version_dirs();
    assert!(!versions.is_empty(), "no version dirs under {}", CORPUS_DIR);

    for version in &versions {
        let files = scenario_files(version);
        assert!(
            !files.is_empty(),
            "no scenario .json files in version {}",
            version
        );

        for path in &files {
            let mut scenario = load_scenario(path);

            // --- The correctness bar: every sse[] event parses into the real enum.
            let sse_json = serde_json::to_value(&scenario.sse).unwrap();
            let envelopes: Vec<SseEnvelope> =
                serde_json::from_value(sse_json).unwrap_or_else(|e| {
                    panic!(
                        "{}: sse[] failed to deserialize into Vec<SseEnvelope>: {}",
                        path.file_name().unwrap().to_string_lossy(),
                        e
                    )
                });
            assert!(
                !envelopes.is_empty(),
                "{}: sse[] is empty",
                path.file_name().unwrap().to_string_lossy()
            );

            // --- Canonicalization is idempotent: run twice, outputs must match.
            canonicalize_scenario(&mut scenario);
            let once = serde_json::to_string_pretty(&scenario).unwrap();

            let mut scenario2 = load_scenario(path);
            canonicalize_scenario(&mut scenario2);
            canonicalize_scenario(&mut scenario2); // second pass
            let twice = serde_json::to_string_pretty(&scenario2).unwrap();

            assert_eq!(
                once,
                twice,
                "{}: canonicalization is not idempotent",
                path.file_name().unwrap().to_string_lossy()
            );
        }
    }
}

/// Asserts each scenario file has the required sections (scenario, version,
/// canonicalization, http, sse) and non-empty sse. Catches a malformed seed
/// fixture before it silently passes the deserialize bar.
#[test]
fn capture_corpus_writes_required_sections() {
    let versions = version_dirs();
    assert!(!versions.is_empty());

    for version in &versions {
        for path in scenario_files(version) {
            let scenario = load_scenario(&path);
            let name = path
                .file_stem()
                .and_then(|n| n.to_str())
                .unwrap_or("?")
                .to_string();

            // Required top-level sections present and non-empty where applicable.
            assert!(!scenario.scenario.is_empty(), "{name}: scenario empty");
            assert!(
                scenario.scenario == name,
                "{name}: scenario field ({}) != filename",
                scenario.scenario
            );
            assert!(!scenario.version.is_empty(), "{name}: version empty");
            assert!(
                !scenario.canonicalization.session_id.is_empty(),
                "{name}: canonicalization.session_id empty"
            );
            assert!(
                !scenario.canonicalization.prompt_ids.is_empty(),
                "{name}: canonicalization.prompt_ids empty"
            );
            assert!(
                !scenario.canonicalization.timestamps.is_empty(),
                "{name}: canonicalization.timestamps empty"
            );
            assert!(!scenario.http.is_empty(), "{name}: http[] empty");
            assert!(!scenario.sse.is_empty(), "{name}: sse[] empty");

            // expected_driver_events must be null in Phase 2.0.5 (not fabricated).
            // `null` deserializes to `None` for `Option<Value>`.
            assert!(
                scenario.expected_driver_events.is_none(),
                "{name}: expected_driver_events must be null in Phase 2.0.5"
            );
        }
    }
}
