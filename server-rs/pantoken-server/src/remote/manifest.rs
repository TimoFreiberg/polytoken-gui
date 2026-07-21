//! Pantoken remote release manifest contract.
//!
//! Re-exports the manifest types and validation from
//! `pantoken_remote_layout::manifest`. The canonical definitions live there so
//! the desktop provisioning layer can use the same types without depending on
//! the entire `pantoken-server` crate.

pub use pantoken_remote_layout::manifest::{
    ArchiveFormat, ManifestError, PantokenReleaseManifest, ReleaseTarget, SUPPORTED_TARGET_TRIPLES,
    validate, validate_target_matrix_completeness,
};
