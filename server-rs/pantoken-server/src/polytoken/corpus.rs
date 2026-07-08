//! Golden daemon corpus loader — the shared parser used by the canonicalization
//! tests (`corpus.rs`) and the fake-daemon integration harness.
//!
//! This is the loader half of `tests/corpus.rs`, extracted so the harness can
//! load a `ScenarioFile` without duplicating parse logic. The canonicalization
//! machinery (the value/frame/http rewriters + the idempotency tests) stays in
//! `corpus.rs`; only the structs + load/enum helpers live here.
//!
//! See `server-rs/tests/corpus/0.4.0-unstable.7/README.md` for the file format.
//
// `load_named`/`sole_version`/`envelope` are consumed by the fake-daemon harness
// (`live_path.rs`), which lands in a later step of this same plan. Until then
// they're unused from `corpus.rs`'s view — silence rather than delete.
#![allow(dead_code)]

use std::fs;
use std::path::PathBuf;

use pantoken_daemon_types::SseEnvelope;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Resolve the corpus root: `<crate>/../tests/corpus` (i.e. `server-rs/tests/corpus`).
pub const CORPUS_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/corpus");

// ---------------------------------------------------------------------------
// Scenario file structs (mirror the JSON shape documented in the README)
// ---------------------------------------------------------------------------

/// The `canonicalization` manifest block of a scenario file.
///
/// `prompt_ids` is a `BTreeMap` (not `HashMap`) so serialization is deterministic
/// — the idempotency test compares pretty-printed JSON, and a `HashMap`'s
/// arbitrary iteration order would make two identical maps serialize differently.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CanonicalizationManifest {
    pub session_id: String,
    pub prompt_ids: std::collections::BTreeMap<String, String>,
    pub timestamps: String,
}

/// One recorded HTTP request/response pair.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpEntry {
    pub method: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_body: Option<Value>,
    pub status: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_body: Option<Value>,
}

/// One SSE frame — the wire shape of a daemon `/events` `data:` payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SseFrame {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<i64>,
    pub emitted_at: String,
    pub session_id: String,
    pub event: Value,
}

impl SseFrame {
    /// Deserialize the frame as the real `SseEnvelope` (the frame shape
    /// `{seq, emitted_at, session_id, event}` IS the envelope shape). The loader
    /// test enforces every frame deserializes, so a daemon event-shape drift
    /// fails loud.
    pub fn envelope(&self) -> Result<SseEnvelope, serde_json::Error> {
        // Round-trip through a Value: the frame fields already match the
        // envelope's (same names), and `event` is a Value that serde will
        // re-parse into the tagged `DaemonEvent` enum.
        let value = serde_json::to_value(self).expect("SseFrame serializable");
        serde_json::from_value::<SseEnvelope>(value)
    }
}

/// A full scenario file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScenarioFile {
    pub scenario: String,
    pub version: String,
    #[allow(dead_code)]
    pub description: String,
    pub canonicalization: CanonicalizationManifest,
    pub http: Vec<HttpEntry>,
    pub sse: Vec<SseFrame>,
    #[allow(dead_code)]
    pub expected_driver_events: Option<Value>,
}

// ---------------------------------------------------------------------------
// Corpus loading helpers
// ---------------------------------------------------------------------------

/// Enumerate every `.json` scenario file under `<corpus>/<version>/`, sorted for
/// deterministic test ordering. Fails loud if the version dir is missing.
pub fn scenario_files(version: &str) -> Vec<PathBuf> {
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
pub fn load_scenario(path: &PathBuf) -> ScenarioFile {
    let text =
        fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {}", path.display(), e));
    serde_json::from_str::<ScenarioFile>(&text)
        .unwrap_or_else(|e| panic!("parse {}: {}", path.display(), e))
}

/// Load a scenario by name from the given version dir.
pub fn load_named(version: &str, name: &str) -> ScenarioFile {
    let path = PathBuf::from(CORPUS_DIR)
        .join(version)
        .join(format!("{name}.json"));
    assert!(path.exists(), "scenario missing: {}", path.display());
    load_scenario(&path)
}

/// The version dir(s) to test. New seed corpora ship under a versioned subdir;
/// this picks up every subdir under the corpus root.
pub fn version_dirs() -> Vec<String> {
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

/// The single canonical version dir the corpus ships under. Returns it if
/// exactly one version dir exists; panics otherwise (the harness assumes a
/// single frozen version, matching "pin the corpus").
pub fn sole_version() -> String {
    let dirs = version_dirs();
    assert_eq!(
        dirs.len(),
        1,
        "expected exactly one corpus version dir, found {:?}",
        dirs
    );
    dirs.into_iter().next().unwrap()
}
