fn main() {
    // Tauri resource staging must run first — the desktop bundle depends on
    // the generated resources.
    tauri_build::build();

    // Compute the SHA256 of each headless release artifact (if present) so the
    // embedded release manifest can point at real, verified artifacts. In local
    // dev and CI gate builds the artifacts don't exist yet — fall back to a
    // placeholder digest (64 zeros, still valid format). Only release builds
    // (tag pushes) embed the real digest.
    set_headless_sha256();
}

/// Set `PANTOKEN_HEADLESS_SHA256_*` env vars from local headless artifacts.
/// Each supported target triple gets its own env var. Missing artifacts use a
/// placeholder (64 zeros). Never panics.
fn set_headless_sha256() {
    let target_dir = std::env::var("CARGO_TARGET_DIR").unwrap_or_else(|_| {
        // Fall back to the standard location relative to the manifest dir.
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into());
        format!("{manifest_dir}/target")
    });

    let headless_dir = format!("{target_dir}/release/headless");

    // The supported target matrix — must match
    // `pantoken-remote-layout::manifest::SUPPORTED_TARGET_TRIPLES` and
    // `scripts/desktop/release-constants.ts::HEADLESS_TARGETS`.
    let targets: &[(&str, &str)] = &[
        // (env var suffix, artifact filename)
        ("MACOS_AARCH64", "pantoken-headless-macos-aarch64.tar.gz"),
        ("LINUX_X86_64", "pantoken-headless-linux-x86_64.tar.gz"),
    ];

    for (suffix, filename) in targets {
        let artifact_path = format!("{headless_dir}/{filename}");
        match std::fs::read(&artifact_path) {
            Ok(bytes) => {
                let digest = compute_sha256(&bytes);
                println!("cargo:rustc-env=PANTOKEN_HEADLESS_SHA256_{suffix}={digest}");
                println!("cargo:rerun-if-changed={artifact_path}");
            }
            Err(_) => {
                println!(
                    "cargo:warning=headless artifact not found at {artifact_path}; using placeholder SHA256"
                );
                println!(
                    "cargo:rustc-env=PANTOKEN_HEADLESS_SHA256_{suffix}={}",
                    "0".repeat(64)
                );
            }
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
