//! Error-notify helpers for config setters (setModel, setThinking, setFacet,
//! setPermissionMonitor, abort). Extracted from `polytoken-driver.ts` so the
//! "emit a visible error notify on failure" pattern is unit-testable without a
//! running daemon.
//!
//! Port of `server/src/polytoken/config-notify.ts`.
//!
//! The driver's config setters used to `.catch(console.error)` only — the
//! operator got no visible signal when a model/facet/monitor change failed.
//! These helpers implement the same error-notify pattern `respondUi` uses inline
//! (`hostUiRequest{kind:"notify", level:"error"}`), plus optional rollback for
//! optimistic setters (setPermissionMonitor).

use pilot_protocol::session_driver::{
    HostUiRequest, NotifyLevel, SessionDriverEvent, SessionEventBase, SessionRef, Timestamp,
};

/// Build a `hostUiRequest{kind:"notify", level:"error"}` event. Pure — no I/O.
/// The `requestId` is namespaced by `operation` so the client can deduplicate
/// if needed (e.g. `setModel-failed-<timestamp>`).
pub fn error_notify(
    r#ref: SessionRef,
    timestamp: Timestamp,
    operation: &str,
    message: &str,
) -> SessionDriverEvent {
    // Namespace the requestId with the operation and the timestamp, replacing
    // `:` and `.` with `-` to keep it URL/id-safe.
    let sanitized_ts = timestamp.replace([':', '.'], "-");
    let request_id = format!("{}-failed-{}", operation, sanitized_ts);
    SessionDriverEvent::HostUiRequest {
        base: SessionEventBase {
            session_ref: r#ref,
            timestamp,
            run_id: None,
        },
        request: HostUiRequest::Notify {
            request_id,
            message: message.to_string(),
            level: Some(NotifyLevel::Error),
        },
    }
}

/// Wrap a future so that on rejection it emits an error notify via the provided
/// `emit` callback, then optionally runs `rollback`. Returns void
/// (fire-and-forget) — the caller doesn't await this; the error is surfaced via
/// the notify, not a thrown promise.
///
/// This is the pattern the config setters should use instead of
/// `.catch(console.error)`:
/// - `future`: the daemon POST (e.g. `ws.client.set_model(...)`)
/// - `emit`: the driver's `emit` closure
/// - `ref`: the warm session's `ws.ref`
/// - `now`: timestamp factory (the driver's `now()` closure)
/// - `operation`: short name for the requestId namespace (e.g. "setModel")
/// - `message`: the human-readable error prefix (e.g. "Failed to set model")
/// - `rollback`: optional cleanup on failure
pub async fn with_error_notify<F, R>(
    future: F,
    emit: &impl Fn(SessionDriverEvent),
    r#ref: SessionRef,
    now: &impl Fn() -> Timestamp,
    operation: &str,
    message: &str,
    rollback: Option<&dyn Fn()>,
) where
    F: std::future::Future<Output = Result<R, Box<dyn std::error::Error + Send + Sync>>>,
{
    match future.await {
        Ok(_) => {}
        Err(e) => {
            let detail = e.to_string();
            let msg = format!("{}: {}", message, detail);
            eprintln!("[polytoken] {} failed: {}", operation, e);
            emit(error_notify(r#ref, now(), operation, &msg));
            if let Some(rb) = rollback {
                if let Err(rb_err) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(rb)) {
                    eprintln!("[polytoken] {} rollback failed: {:?}", operation, rb_err);
                }
            }
        }
    }
}
