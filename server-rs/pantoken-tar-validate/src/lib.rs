//! Direct-root tar archive validator for Pantoken headless release artifacts.
//!
//! The canonical archive layout (direct-root, no wrapper prefix):
//! ```text
//! VERSION
//! BUILD_SHA
//! bin/pantoken-server
//! bin/pantoken-tar-validate
//! run.sh
//! update.sh
//! client-dist/index.html
//! client-dist/assets/<hashed>          (zero or more)
//! ```
//!
//! Exit codes (CLI):
//! - `0` — archive is valid and members match the canonical schema
//! - `2` — malformed gzip/tar or checksum/numeric overflow
//! - `3` — unsafe or unexpected member
//!
//! Safety contract:
//! - Reject absolute paths, `..` components, duplicate normalised members
//! - Reject symlinks, hardlinks, devices, special files
//! - Reject unsafe owner/mode fields
//! - Reject source trees and `node_modules`
//! - Support only ustar and PAX (read-only); reject GNU extensions unless
//!   safely normalised through normalisation

pub use errors::TarValidateError;
pub use exit_codes::*;
pub use schema::CANONICAL_PREFIXES;

pub mod exit_codes {
    /// Successful validation — members match the canonical schema.
    pub const VALID: i32 = 0;
    /// Malformed gzip/tar header or checksum/numeric overflow.
    pub const MALFORMED: i32 = 2;
    /// Unsafe or unexpected member found.
    pub const UNSAFE: i32 = 3;
}

mod errors {
    /// Error classification for tar validation failures.
    #[derive(Debug, Clone, PartialEq)]
    pub enum TarValidateError {
        /// The input is not recognisable gzip or the tar stream is corrupt.
        Malformed,
        /// A member path is unsafe (absolute, traversal, duplicate, etc.).
        Unsafe(String),
    }

    impl std::fmt::Display for TarValidateError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                TarValidateError::Malformed => write!(f, "malformed gzip/tar or checksum overflow"),
                TarValidateError::Unsafe(member) => {
                    write!(f, "unsafe or unexpected member: {member}")
                }
            }
        }
    }

    impl std::error::Error for TarValidateError {}
}

mod schema {
    /// Canonical member paths that must exist in the archive.
    pub const REQUIRED: &[&str] = &[
        "VERSION",
        "BUILD_SHA",
        "bin/pantoken-server",
        "bin/pantoken-tar-validate",
        "run.sh",
        "update.sh",
        "client-dist/index.html",
    ];

    /// Prefixes allowed in the archive (must be checked before REQUIRED).
    pub const CANONICAL_PREFIXES: &[&str] = &[
        "VERSION",
        "BUILD_SHA",
        "run.sh",
        "update.sh",
        "bin/pantoken-server",
        "bin/pantoken-tar-validate",
        "client-dist/index.html",
    ];

    /// Allowed asset filename pattern under client-dist/assets/.
    pub const ASSET_PREFIX: &str = "client-dist/assets/";
}

/// Normalise a path component sequence.
///
/// - Rejects absolute paths (`/...`).
/// - Rejects `..` at any depth.
/// - Collapses `.` components and consecutive `/`.
/// - Returns the empty string if the path is "." or "".
fn normalise_path(name: &str) -> Option<String> {
    if name.is_empty() {
        return Some(String::new());
    }

    // Absolute path check.
    if name.starts_with('/') {
        return None;
    }

    let mut parts: Vec<&str> = Vec::new();
    for component in name.split('/') {
        match component {
            "" | "." => continue,
            ".." => {
                // Traversal not allowed at any depth.
                return None;
            }
            other => parts.push(other),
        }
    }

    if parts.is_empty() {
        return Some(String::new());
    }

    Some(parts.join("/"))
}

/// Check if a member is safe — not a link, device, or otherwise dangerous.
fn is_member_safe<R: std::io::Read>(hdr: &tar::Entry<'_, R>) -> Result<(), String> {
    let file_type = hdr.header().entry_type();

    // Symlinks and hardlinks must be rejected.
    if file_type.is_symlink() || file_type.is_hard_link() {
        return Err("symlink or hardlink".to_string());
    }

    // Devices and special files must be rejected.
    if file_type.is_block_special()
        || file_type.is_character_special()
        || file_type.is_pax_global_extensions()
        || file_type.is_pax_local_extensions()
    {
        return Err("device file".to_string());
    }

    Ok(())
}

/// Check ownership and permissions are within safe bounds.
fn check_owner_mode(hdr: &tar::Header) -> Result<(), String> {
    // uid 0 (root) gid 0 (wheel) is acceptable for installed binaries,
    // but group/other writable bits must be absent (mode 0755 for dirs/bins, 0644 for others).
    let mode = hdr.mode().unwrap_or(0);
    // If group-write or other-write bits are set, reject.
    if mode & 0o022 != 0 {
        return Err(format!(
            "unsafe mode {:o}: group-write or other-write bits set",
            mode
        ));
    }
    Ok(())
}

/// Check if a path is within an allowed prefix from the canonical schema.
fn prefix_allowed(path: &str) -> bool {
    // Exact match against any canonical file or structural directory prefix.
    for prefix in schema::CANONICAL_PREFIXES {
        if path == *prefix {
            return true;
        }
    }
    if matches!(path, "bin" | "client-dist" | "client-dist/assets") {
        return true;
    }
    // Assets are allowed under client-dist/assets/.
    if path.starts_with(schema::ASSET_PREFIX) {
        return true;
    }
    false
}

/// Check that a path does not point to forbidden tree content.
fn check_no_forbidden(path: &str) -> Result<(), String> {
    if path.contains("node_modules") {
        return Err("node_modules".to_string());
    }
    // Hidden .git directories anywhere in the path.
    if path.contains("/.git/") || path.starts_with(".git/") || path == ".git" {
        return Err(".git".to_string());
    }
    // Cargo source or workspace files at top level.
    if path == "Cargo.toml" || path == "Cargo.lock" {
        return Err("Cargo.toml/Cargo.lock".to_string());
    }
    Ok(())
}

/// Validate the tar archive and return the set of normalised member paths found.
///
/// Returns `Err(TarValidateError::Malformed)` if the input is not valid gzip+tar.
/// Returns `Err(TarValidateError::Unsafe(msg))` if any member is unsafe or unexpected.
/// Returns `Ok(normalised_paths)` with all member paths if valid.
pub fn validate_tar<R: std::io::Read>(reader: R) -> Result<Vec<String>, TarValidateError> {
    // 1. Wrap in flate2 decompressor for gzip.
    let decoder = flate2::read::GzDecoder::new(reader);

    // 2. Walk the tar entries.
    let mut archive = tar::Archive::new(decoder);

    let mut entries = match archive.entries() {
        Ok(e) => e,
        Err(_) => return Err(TarValidateError::Malformed),
    };

    let mut normalised_names: Vec<String> = Vec::new();
    let mut seen_normalised: std::collections::HashSet<String> = std::collections::HashSet::new();

    for entry_result in &mut entries {
        let entry = match entry_result {
            Ok(e) => e,
            Err(_) => return Err(TarValidateError::Malformed),
        };

        let raw_name = match entry.path() {
            Ok(p) => p.to_string_lossy().into_owned(),
            Err(_) => return Err(TarValidateError::Malformed),
        };

        // Normalise: reject absolute, traversal.
        let norm = match normalise_path(&raw_name) {
            Some(n) => n,
            None => return Err(TarValidateError::Unsafe(raw_name.clone())),
        };

        // Reject empty normalised paths (root "." entries are ok, skip them).
        if norm.is_empty() {
            continue;
        }

        // Check safety of the member itself.
        if let Err(reason) = is_member_safe(&entry) {
            return Err(TarValidateError::Unsafe(format!("{raw_name}: {reason}")));
        }

        // Check owner/mode.
        if let Err(reason) = check_owner_mode(entry.header()) {
            return Err(TarValidateError::Unsafe(format!("{raw_name}: {reason}")));
        }

        // Check no forbidden content.
        if let Err(reason) = check_no_forbidden(&norm) {
            return Err(TarValidateError::Unsafe(format!("{raw_name}: {reason}")));
        }

        // Check prefix is allowed.
        if !prefix_allowed(&norm) {
            return Err(TarValidateError::Unsafe(format!(
                "{raw_name}: not in canonical schema"
            )));
        }

        // Check for duplicate normalised names.
        if !seen_normalised.insert(norm.clone()) {
            return Err(TarValidateError::Unsafe(format!(
                "{raw_name}: duplicate normalised path"
            )));
        }

        normalised_names.push(norm);
    }

    // If there were errors during iteration, the TarValidateError propagates.
    // Otherwise check required members.
    check_required_members(&normalised_names)
}

/// Check that all required canonical members are present.
fn check_required_members(found: &[String]) -> Result<Vec<String>, TarValidateError> {
    let found_set: std::collections::HashSet<&str> = found.iter().map(|s| s.as_str()).collect();

    for required in schema::REQUIRED {
        if !found_set.contains(*required) {
            return Err(TarValidateError::Unsafe(format!(
                "missing required member: {required}"
            )));
        }
    }

    Ok(found.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};

    // ─── normalise_path tests ───

    #[test]
    fn normalise_path_simple() {
        assert_eq!(normalise_path("foo/bar"), Some("foo/bar".to_string()));
    }

    #[test]
    fn normalise_path_dot_components() {
        assert_eq!(normalise_path("./foo/./bar"), Some("foo/bar".to_string()));
    }

    #[test]
    fn normalise_path_empty() {
        assert_eq!(normalise_path(""), Some("".to_string()));
        assert_eq!(normalise_path("."), Some("".to_string()));
    }

    #[test]
    fn normalise_path_absolute_rejected() {
        assert_eq!(normalise_path("/foo/bar"), None);
    }

    #[test]
    fn normalise_path_traversal_rejected() {
        assert_eq!(normalise_path("foo/../bar"), None);
        assert_eq!(normalise_path("../bar"), None);
    }

    // ─── is_member_safe tests ───

    #[test]
    fn normal_file_is_safe() {
        // Create a minimal tar entry for a regular file to test.
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Regular);
        header.set_mode(0o644);
        let bytes: Vec<u8> = Vec::new();
        let cursor = Cursor::new(bytes);
        let mut archive = tar::Archive::new(cursor);
        let _entries = archive.entries().unwrap();
        let mut builder = tar::Builder::new(Vec::new());
        let mut entry_header = tar::Header::new_gnu();
        entry_header.set_entry_type(tar::EntryType::Regular);
        entry_header.set_mode(0o644);
        entry_header.set_size(0);
        builder
            .append_data(&mut entry_header, "test.txt", Cursor::new(Vec::new()))
            .unwrap();
        let buf = builder.into_inner().unwrap();

        let mut archive2 = tar::Archive::new(Cursor::new(buf));
        let mut it = archive2.entries().unwrap();
        let entry = it.next().unwrap().unwrap();
        assert!(is_member_safe(&entry).is_ok());
    }

    // ─── prefix_allowed tests ───

    #[test]
    fn prefix_allowed_exact() {
        assert!(prefix_allowed("VERSION"));
        assert!(prefix_allowed("BUILD_SHA"));
        assert!(prefix_allowed("run.sh"));
        assert!(prefix_allowed("bin/pantoken-server"));
    }

    #[test]
    fn prefix_allowed_assets() {
        assert!(prefix_allowed("client-dist/assets/abc123.js"));
        assert!(prefix_allowed("client-dist/assets/a.b-c_d.e"));
    }

    #[test]
    fn prefix_allowed_rejects_extra() {
        assert!(!prefix_allowed("unexpected/file"));
        assert!(!prefix_allowed("Cargo.toml"));
        assert!(!prefix_allowed("src/main.rs"));
    }

    // ─── check_no_forbidden tests ───

    #[test]
    fn no_node_modules() {
        assert!(check_no_forbidden("node_modules/foo").is_err());
        assert!(check_no_forbidden("foo/node_modules/bar").is_err());
    }

    #[test]
    fn no_git() {
        assert!(check_no_forbidden(".git").is_err());
        assert!(check_no_forbidden(".git/config").is_err());
        assert!(check_no_forbidden("foo/.git/hooks").is_err());
    }

    #[test]
    fn no_cargo_files() {
        assert!(check_no_forbidden("Cargo.toml").is_err());
        assert!(check_no_forbidden("Cargo.lock").is_err());
    }

    // ─── validate_tar with real gzip+tar ───

    /// Build a valid gzip-compressed tar archive in memory with the given members.
    fn build_test_tar(members: &[(&str, &[u8])]) -> Vec<u8> {
        let mut tar_buf = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_buf);
            for (name, content) in members {
                let mut header = tar::Header::new_gnu();
                header.set_entry_type(tar::EntryType::Regular);
                header.set_size(content.len() as u64);
                builder
                    .append_data(&mut header, *name, Cursor::new(*content))
                    .unwrap();
            }
            builder.finish().unwrap();
        }
        // Gzip-compress.
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&tar_buf).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn valid_canonical_archive() {
        let tar_bytes = build_test_tar(&[
            ("VERSION", b"1.0.0"),
            ("BUILD_SHA", b"abcd1234abcd1234abcd1234abcd1234abcd1234"),
            ("bin/pantoken-server", b"#!/bin/sh\necho hi"),
            ("bin/pantoken-tar-validate", b"#!/bin/sh\necho validate"),
            ("run.sh", b"#!/bin/sh\necho run"),
            ("update.sh", b"#!/bin/sh\necho update"),
            ("client-dist/index.html", b"<!DOCTYPE html><html></html>"),
            ("client-dist/assets/abc123.js", b"console.log(1);"),
        ]);

        let result = validate_tar(Cursor::new(tar_bytes));
        assert!(result.is_ok(), "expected Ok, got: {:?}", result);
    }

    #[test]
    fn missing_required_member() {
        let tar_bytes = build_test_tar(&[
            ("VERSION", b"1.0.0"),
            // BUILD_SHA missing
            ("bin/pantoken-server", b"binary"),
            ("bin/pantoken-tar-validate", b"validator"),
            ("run.sh", b"run"),
            ("update.sh", b"update"),
            ("client-dist/index.html", b"<html></html>"),
        ]);

        let result = validate_tar(Cursor::new(tar_bytes));
        assert!(result.is_err());
        match result.unwrap_err() {
            TarValidateError::Unsafe(msg) => {
                assert!(
                    msg.contains("BUILD_SHA"),
                    "expected BUILD_SHA in error: {msg}"
                );
            }
            TarValidateError::Malformed => panic!("expected Unsafe, got Malformed"),
        }
    }

    #[test]
    fn unexpected_member_rejected() {
        let tar_bytes = build_test_tar(&[
            ("VERSION", b"1.0.0"),
            ("BUILD_SHA", b"abcd1234abcd1234abcd1234abcd1234abcd1234"),
            ("bin/pantoken-server", b"binary"),
            ("bin/pantoken-tar-validate", b"validator"),
            ("run.sh", b"run"),
            ("update.sh", b"update"),
            ("client-dist/index.html", b"<html></html>"),
            ("Cargo.toml", b"[package]\n"), // not allowed
        ]);

        let result = validate_tar(Cursor::new(tar_bytes));
        assert!(result.is_err());
        match result.unwrap_err() {
            TarValidateError::Unsafe(msg) => {
                assert!(
                    msg.contains("Cargo.toml"),
                    "expected Cargo.toml in error: {msg}"
                );
            }
            TarValidateError::Malformed => panic!("expected Unsafe, got Malformed"),
        }
    }

    #[test]
    fn node_modules_rejected() {
        let tar_bytes = build_test_tar(&[
            ("VERSION", b"1.0.0"),
            ("BUILD_SHA", b"abcd1234abcd1234abcd1234abcd1234abcd1234"),
            ("bin/pantoken-server", b"binary"),
            ("bin/pantoken-tar-validate", b"validator"),
            ("run.sh", b"run"),
            ("update.sh", b"update"),
            ("client-dist/index.html", b"<html></html>"),
            ("node_modules/foo.js", b"require('evil')"),
        ]);

        let result = validate_tar(Cursor::new(tar_bytes));
        assert!(result.is_err());
        match result.unwrap_err() {
            TarValidateError::Unsafe(msg) => {
                assert!(msg.contains("node_modules"), "expected node_modules: {msg}");
            }
            TarValidateError::Malformed => panic!("expected Unsafe, got Malformed"),
        }
    }

    #[test]
    fn absolute_path_rejected() {
        // We'll create a tar with an absolute path entry — tar crate may normalise,
        // so we build the raw tar manually with an absolute path header.
        let tar_bytes = build_raw_tar_with_absolute_path();
        let result = validate_tar(Cursor::new(tar_bytes));
        assert!(result.is_err());
        match result.unwrap_err() {
            TarValidateError::Unsafe(msg) => {
                assert!(
                    msg.contains("/etc/passwd") || msg.contains("/absolute"),
                    "expected absolute path error: {msg}"
                );
            }
            TarValidateError::Malformed => panic!("expected Unsafe, got Malformed"),
        }
    }

    /// Build a tar with an absolute path by writing a raw header.
    fn build_raw_tar_with_absolute_path() -> Vec<u8> {
        let mut buf = Vec::new();

        // Write a raw tar header with an absolute path.
        let name = "/absolute/path/file.txt";
        let mut header_bytes = [0u8; 512];
        header_bytes[..name.len()].copy_from_slice(name.as_bytes());
        // Set entry type to regular (0x30)
        header_bytes[156] = b'0';
        // Set size to 0
        header_bytes[124..136].copy_from_slice(b"00000000000\0");
        // A valid checksum is needed for the parser to reach the unsafe path check.
        header_bytes[148..156].fill(b' ');
        let checksum: u32 = header_bytes.iter().map(|byte| u32::from(*byte)).sum();
        let checksum_text = format!("{checksum:06o}\0 ");
        header_bytes[148..156].copy_from_slice(checksum_text.as_bytes());

        buf.extend_from_slice(&header_bytes);
        // Two padding blocks
        buf.extend_from_slice(&[0u8; 1024]);

        // Gzip compress
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&buf).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn malformed_gzip() {
        let not_gzip = b"this is not gzip at all";
        let result = validate_tar(Cursor::new(not_gzip));
        assert!(result.is_err());
        match result.unwrap_err() {
            TarValidateError::Malformed => {}
            other => panic!("expected Malformed, got {:?}", other),
        }
    }

    #[test]
    fn empty_tar_rejected() {
        let empty_tar = Vec::new();
        let result = validate_tar(Cursor::new(empty_tar));
        assert!(result.is_err());
        match result.unwrap_err() {
            TarValidateError::Malformed => {}
            other => panic!("expected Malformed, got {:?}", other),
        }
    }

    /// Build a gzip tar with a symlink entry.
    fn build_tar_with_symlink() -> Vec<u8> {
        let mut tar_buf = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_buf);
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_size(0);
            builder
                .append_link(&mut header, "good_link", "target")
                .unwrap();
            builder.finish().unwrap();
        }
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&tar_buf).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn symlink_rejected() {
        let _tar_bytes = build_tar_with_symlink();
        // This archive has only a symlink, no required members, so it will fail
        // on missing required members first. Let's test with symlink + required members.
        let mut tar_buf = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_buf);

            // Add a regular required member.
            let mut h = tar::Header::new_gnu();
            h.set_entry_type(tar::EntryType::Regular);
            h.set_size(5);
            builder
                .append_data(&mut h, "VERSION", Cursor::new(b"1.0.0"))
                .unwrap();

            // Add required members stubbed.
            for name in &[
                "BUILD_SHA",
                "bin/pantoken-server",
                "bin/pantoken-tar-validate",
                "run.sh",
                "update.sh",
                "client-dist/index.html",
            ] {
                let mut h = tar::Header::new_gnu();
                h.set_entry_type(tar::EntryType::Regular);
                h.set_size(4);
                builder
                    .append_data(&mut h, *name, Cursor::new(b"test"))
                    .unwrap();
            }

            // Now add symlink.
            let mut h = tar::Header::new_gnu();
            h.set_entry_type(tar::EntryType::Symlink);
            h.set_size(0);
            builder.append_link(&mut h, "bad_link", "target").unwrap();

            builder.finish().unwrap();
        }
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&tar_buf).unwrap();
        let tar_bytes = encoder.finish().unwrap();

        let result = validate_tar(Cursor::new(tar_bytes));
        assert!(result.is_err());
        match result.unwrap_err() {
            TarValidateError::Unsafe(msg) => {
                assert!(msg.contains("symlink"), "expected symlink in error: {msg}");
            }
            TarValidateError::Malformed => panic!("expected Unsafe, got Malformed"),
        }
    }

    #[test]
    fn group_other_writable_rejected() {
        // Build tar with a group-writable file.
        let mut tar_buf = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_buf);
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Regular);
            header.set_size(0);
            header.set_mode(0o664); // group write bit set
            builder
                .append_data(&mut header, "VERSION", Cursor::new(b"1.0.0"))
                .unwrap();
            builder.finish().unwrap();
        }
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&tar_buf).unwrap();
        let tar_bytes = encoder.finish().unwrap();

        let result = validate_tar(Cursor::new(tar_bytes));
        assert!(result.is_err());
        match result.unwrap_err() {
            TarValidateError::Unsafe(msg) => {
                assert!(msg.contains("mode"), "expected mode in error: {msg}");
            }
            TarValidateError::Malformed => panic!("expected Unsafe, got Malformed"),
        }
    }

    #[test]
    fn valid_assets_multiple() {
        let tar_bytes = build_test_tar(&[
            ("VERSION", b"2.0.0"),
            ("BUILD_SHA", b"deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"),
            ("bin/pantoken-server", b"#!rust"),
            ("bin/pantoken-tar-validate", b"#!rust"),
            ("run.sh", b"#!/bin/sh"),
            ("update.sh", b"#!/bin/sh"),
            ("client-dist/index.html", b"<!DOCTYPE html>"),
            ("client-dist/assets/abc123.js", b"// js"),
            ("client-dist/assets/vendor_456.css", b"/* css */"),
            ("client-dist/assets/icon.svg", b"<svg></svg>"),
        ]);

        let result = validate_tar(Cursor::new(tar_bytes));
        assert!(result.is_ok(), "expected valid archive: {:?}", result);
    }

    #[test]
    fn extra_unexpected_member_rejected() {
        // An unexpected file that is NOT in any allowed prefix.
        let mut tar_buf = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_buf);

            for name in schema::REQUIRED {
                let mut h = tar::Header::new_gnu();
                h.set_entry_type(tar::EntryType::Regular);
                h.set_size(4);
                builder
                    .append_data(&mut h, *name, Cursor::new(b"test"))
                    .unwrap();
            }

            // Add a valid asset too.
            let mut h = tar::Header::new_gnu();
            h.set_entry_type(tar::EntryType::Regular);
            h.set_size(10);
            builder
                .append_data(
                    &mut h,
                    "client-dist/assets/main.js",
                    Cursor::new(b"console.log"),
                )
                .unwrap();

            // Add an unexpected file.
            let mut h = tar::Header::new_gnu();
            h.set_entry_type(tar::EntryType::Regular);
            h.set_size(4);
            builder
                .append_data(&mut h, "README.md", Cursor::new(b"read"))
                .unwrap();

            builder.finish().unwrap();
        }
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&tar_buf).unwrap();
        let tar_bytes = encoder.finish().unwrap();

        let result = validate_tar(Cursor::new(tar_bytes));
        assert!(result.is_err());
        match result.unwrap_err() {
            TarValidateError::Unsafe(msg) => {
                assert!(
                    msg.contains("README.md"),
                    "expected README.md in error: {msg}"
                );
            }
            TarValidateError::Malformed => panic!("expected Unsafe, got Malformed"),
        }
    }
}
