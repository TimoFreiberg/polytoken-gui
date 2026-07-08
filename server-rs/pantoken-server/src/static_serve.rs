//! Serve the built Svelte client (client/dist) so prod is a single process. In dev
//! this is unused — Vite serves the client and proxies /ws + /debug here.
//!
//! Delivery policy (the phone-over-Tailscale reality: every uncached byte is paid
//! for on a slow link, and every launch used to re-download the whole ~860KB bundle):
//! - `/assets/*` carries a content hash in the filename → immutable year-long
//!   cache. A missing hashed asset is a 404, NEVER the SPA fallback — serving
//!   index.html as a .js response after a deploy swap is the classic
//!   stale-deploy white screen.
//! - Everything else (index.html, sw.js, manifest, icons) revalidates on every
//!   load (`no-cache`) but answers 304 via ETag, so "revalidate" costs a header
//!   round-trip, not a re-download.
//! - Compressible types are gzipped once per process and cached in memory (the
//!   dist is small and immutable while the server runs — updates restart it).
//!
//! Port of `server/src/static.ts`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use parking_lot::RwLock;
use tracing::warn;

const COMPRESSIBLE: &[&str] = &[
    ".js",
    ".mjs",
    ".css",
    ".html",
    ".svg",
    ".json",
    ".webmanifest",
    ".map",
    ".txt",
];

/// Below this, gzip's frame overhead + CPU isn't worth the bytes saved.
const GZIP_MIN_BYTES: usize = 1024;

/// Per-process caches keyed by dist-relative path. Safe because the dist is
/// immutable for the process lifetime (the desktop updater restarts the server).
#[derive(Default)]
struct StaticCache {
    gzip: HashMap<String, Arc<Vec<u8>>>,
    etag: HashMap<String, String>,
}

pub struct StaticServer {
    dist: PathBuf,
    cache: RwLock<StaticCache>,
}

impl StaticServer {
    pub fn new(dist: PathBuf) -> Self {
        Self {
            dist,
            cache: RwLock::new(StaticCache::default()),
        }
    }

    /// Try to serve a static file for the given path. Returns `Ok(response)` if
    /// found, or `Err(())` if no build is present (caller returns a hint).
    pub async fn serve(&self, pathname: &str, req_headers: &HeaderMap) -> Result<Response, ()> {
        // strip leading slash + defuse path traversal
        let rel = normalize_path(pathname);
        let file_path = self.dist.join(&rel);

        if file_path.is_file() {
            return Ok(self.respond(&rel, &file_path, req_headers).await);
        }

        // A hashed asset that doesn't exist is a stale/mismatched deploy — 404 so the
        // browser fails loudly instead of caching index.html as JavaScript.
        if rel.starts_with("assets/") {
            return Ok((StatusCode::NOT_FOUND, "not found").into_response());
        }

        // SPA fallback to index.html for client-side routes
        let index_path = self.dist.join("index.html");
        if index_path.is_file() {
            return Ok(self.respond("index.html", &index_path, req_headers).await);
        }

        // No build present (dev) — caller returns a hint
        Err(())
    }

    /// Build the asset response: cache headers by class, ETag/304 for revalidating
    /// files, gzip when the client accepts it and the type is worth it.
    async fn respond(&self, rel: &str, file_path: &Path, req_headers: &HeaderMap) -> Response {
        let immutable = rel.starts_with("assets/");
        let bytes = match std::fs::read(file_path) {
            Ok(b) => b,
            Err(e) => {
                warn!("failed to read static file {}: {e}", file_path.display());
                return (StatusCode::INTERNAL_SERVER_ERROR, "read error").into_response();
            }
        };

        let ext = file_path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| format!(".{}", e.to_lowercase()))
            .unwrap_or_else(|| ".html".into());

        let compressible = COMPRESSIBLE.contains(&ext.as_str());

        let cache_control = if immutable {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        };

        // Revalidation via ETag for the no-cache class (index.html, sw.js, …):
        // a match answers 304 with no body. Immutable assets skip the tag —
        // their URL changes when their content does.
        if !immutable {
            let etag = self.etag_for(rel, &bytes);
            if let Some(if_none_match) = req_headers.get(header::IF_NONE_MATCH) {
                if if_none_match.as_bytes() == etag.as_bytes() {
                    return Response::builder()
                        .status(StatusCode::NOT_MODIFIED)
                        .header(header::CACHE_CONTROL, cache_control)
                        .header(header::ETAG, &etag)
                        .body(Body::empty())
                        .unwrap();
                }
            }
        }

        let accepts_gzip = req_headers
            .get(header::ACCEPT_ENCODING)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.split([',', ' ']).any(|part| part.trim() == "gzip"))
            .unwrap_or(false);

        let mut builder = Response::builder()
            .status(StatusCode::OK)
            .header(header::CACHE_CONTROL, cache_control);

        if !immutable {
            let etag = self.etag_for(rel, &bytes);
            builder = builder.header(header::ETAG, &etag);
        }

        if compressible {
            builder = builder.header(header::VARY, "accept-encoding");
        }

        if let Ok(ct) = mime_type(&ext) {
            builder = builder.header(header::CONTENT_TYPE, ct);
        }

        if accepts_gzip && compressible && bytes.len() >= GZIP_MIN_BYTES {
            if let Some(gz) = self.gzipped(rel, &bytes, &ext) {
                return builder
                    .header(header::CONTENT_ENCODING, "gzip")
                    .body(Body::from(gz.as_slice().to_vec()))
                    .unwrap();
            }
        }

        builder.body(Body::from(bytes)).unwrap()
    }

    fn etag_for(&self, rel: &str, bytes: &[u8]) -> String {
        {
            let cache = self.cache.read();
            if let Some(tag) = cache.etag.get(rel) {
                return tag.clone();
            }
        }
        let hash = xxhash(bytes);
        let tag = format!("\"{:x}-{:x}\"", hash, bytes.len());
        self.cache.write().etag.insert(rel.to_string(), tag.clone());
        tag
    }

    fn gzipped(&self, rel: &str, bytes: &[u8], ext: &str) -> Option<Arc<Vec<u8>>> {
        if !COMPRESSIBLE.contains(&ext) {
            return None;
        }
        if bytes.len() < GZIP_MIN_BYTES {
            return None;
        }
        {
            let cache = self.cache.read();
            if let Some(gz) = cache.gzip.get(rel) {
                return Some(gz.clone());
            }
        }
        let gz = gzip_bytes(bytes)?;
        let arc = Arc::new(gz);
        self.cache.write().gzip.insert(rel.to_string(), arc.clone());
        Some(arc)
    }
}

/// Strip leading slashes and defuse path traversal (`..` segments).
fn normalize_path(pathname: &str) -> String {
    let stripped = pathname
        .trim_start_matches(['/', '\\'])
        .trim_start_matches("..")
        .trim_start_matches(['/', '\\']);
    // Remove any remaining `..` segments
    stripped
        .split('/')
        .filter(|seg| *seg != ".." && !seg.is_empty())
        .collect::<Vec<_>>()
        .join("/")
        .trim_start_matches('/')
        .to_string()
}

/// Simple content-addressed hash (not cryptographic — just for ETags).
fn xxhash(data: &[u8]) -> u64 {
    // A simple FNV-1a hash — adequate for ETag uniqueness within a single process.
    let mut hash: u64 = 0xcbf29ce484222325;
    for &byte in data {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn gzip_bytes(data: &[u8]) -> Option<Vec<u8>> {
    use flate2::write::GzEncoder;
    use std::io::Write;
    let mut encoder = GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(data).ok()?;
    encoder.finish().ok()
}

fn mime_type(ext: &str) -> Result<&'static str, ()> {
    Ok(match ext {
        ".js" | ".mjs" => "text/javascript",
        ".css" => "text/css",
        ".html" => "text/html; charset=utf-8",
        ".svg" => "image/svg+xml",
        ".json" => "application/json",
        ".webmanifest" => "application/manifest+json",
        ".map" => "application/json",
        ".txt" => "text/plain; charset=utf-8",
        ".png" => "image/png",
        ".jpg" | ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".ico" => "image/x-icon",
        ".woff" => "font/woff",
        ".woff2" => "font/woff2",
        ".wasm" => "application/wasm",
        _ => return Err(()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    #[test]
    fn normalize_strips_leading_slash() {
        assert_eq!(normalize_path("/index.html"), "index.html");
        assert_eq!(normalize_path("/assets/app.js"), "assets/app.js");
    }

    #[test]
    fn normalize_defuses_traversal() {
        assert_eq!(normalize_path("/../../etc/passwd"), "etc/passwd");
        assert_eq!(normalize_path("/../assets/../../etc"), "assets/etc");
    }

    #[test]
    fn normalize_empty_path() {
        assert_eq!(normalize_path("/"), "");
    }

    #[test]
    fn gzip_produces_valid_output() {
        let input = b"hello world ".repeat(100);
        let gz = gzip_bytes(&input).unwrap();
        assert!(!gz.is_empty());
        // Gzip magic bytes
        assert_eq!(&gz[0..2], &[0x1f, 0x8b]);
    }

    #[test]
    fn mime_type_known_extensions() {
        assert_eq!(mime_type(".js").unwrap(), "text/javascript");
        assert_eq!(mime_type(".css").unwrap(), "text/css");
        assert_eq!(mime_type(".html").unwrap(), "text/html; charset=utf-8");
        assert!(mime_type(".unknown").is_err());
    }

    // ── Ported from static.test.ts.bak ──────────────────────────

    fn make_dist() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("index.html"), b"<!doctype html>spa").unwrap();
        dir
    }

    fn empty_headers() -> HeaderMap {
        HeaderMap::new()
    }

    #[tokio::test]
    async fn index_html_falls_back_for_non_hashed_routes() {
        let dir = make_dist();
        let server = StaticServer::new(dir.path().to_path_buf());
        let res = server.serve("/", &empty_headers()).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(&body[..], b"<!doctype html>spa");
    }

    #[tokio::test]
    async fn hashed_assets_get_immutable_cache() {
        let dir = make_dist();
        // Create a hashed asset file so the server can find it
        let asset_dir = dir.path().join("assets");
        std::fs::create_dir_all(&asset_dir).unwrap();
        std::fs::write(asset_dir.join("app-abc123.js"), b"console.log('hi');").unwrap();
        let server = StaticServer::new(dir.path().to_path_buf());
        let res = server
            .serve("/assets/app-abc123.js", &empty_headers())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            res.headers().get(header::CACHE_CONTROL).unwrap(),
            HeaderValue::from_static("public, max-age=31536000, immutable")
        );
    }

    #[tokio::test]
    async fn missing_hashed_asset_is_404_not_spa_fallback() {
        let dir = make_dist();
        let server = StaticServer::new(dir.path().to_path_buf());
        let res = server
            .serve("/assets/gone-999.js", &empty_headers())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn index_revalidates_no_cache_etag_then_304() {
        let dir = make_dist();
        let server = StaticServer::new(dir.path().to_path_buf());

        // First request: 200 + no-cache + ETag
        let first = server.serve("/", &empty_headers()).await.unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(
            first.headers().get(header::CACHE_CONTROL).unwrap(),
            HeaderValue::from_static("no-cache")
        );
        let etag = first.headers().get(header::ETAG).unwrap().clone();

        // Second request with matching If-None-Match → 304
        let mut headers = HeaderMap::new();
        headers.insert(header::IF_NONE_MATCH, etag);
        let second = server.serve("/", &headers).await.unwrap();
        assert_eq!(second.status(), StatusCode::NOT_MODIFIED);
        let body = axum::body::to_bytes(second.into_body(), usize::MAX)
            .await
            .unwrap();
        assert!(body.is_empty());
    }
}
