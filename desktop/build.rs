fn main() {
    // Tauri resource staging must run first — the desktop bundle depends on
    // the generated resources.
    tauri_build::build();

    // Compute the SHA256 of the headless release artifact (if present) so the
    // embedded release manifest can point at a real, verified artifact. In
    // local dev and CI gate builds the artifact doesn't exist yet — fall back
    // to a placeholder digest (64 zeros, still valid format).
    set_headless_sha256();
}

/// Set `PANTOKEN_HEADLESS_SHA256` as a rustc env var from the local headless
/// artifact. Never panics — a missing artifact uses a placeholder.
fn set_headless_sha256() {
    let target_dir = std::env::var("CARGO_TARGET_DIR").unwrap_or_else(|_| {
        // Fall back to the standard location relative to the manifest dir.
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into());
        format!("{manifest_dir}/target")
    });

    let artifact_path = format!(
        "{target_dir}/release/headless/pantoken-headless-macos-aarch64.tar.gz"
    );

    match std::fs::read(&artifact_path) {
        Ok(bytes) => {
            let digest = compute_sha256(&bytes);
            println!("cargo:rustc-env=PANTOKEN_HEADLESS_SHA256={digest}");
        }
        Err(_) => {
            println!(
                "cargo:warning=headless artifact not found at {artifact_path}; using placeholder SHA256"
            );
            println!(
                "cargo:rustc-env=PANTOKEN_HEADLESS_SHA256={}",
                "0".repeat(64)
            );
        }
    }
}

/// Compute the SHA256 hex digest of a byte buffer.
fn compute_sha256(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(data);
    let result = hasher.finalize();
    result.iter().map(|b| format!("{:02x}", b)).collect()
}
