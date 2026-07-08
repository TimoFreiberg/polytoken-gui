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

use pantoken_protocol::session_driver::{
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

#[cfg(test)]
mod tests {
    use super::*;

    fn test_ref() -> SessionRef {
        SessionRef {
            workspace_id: "/test".to_string(),
            session_id: "test-sid".to_string(),
        }
    }

    const TS: &str = "2026-07-02T12:00:00.000Z";

    #[test]
    fn builds_host_ui_request_notify_event_with_level_error() {
        let ev = error_notify(
            test_ref(),
            TS.to_string(),
            "setModel",
            "Failed to set model: 500",
        );
        match ev {
            SessionDriverEvent::HostUiRequest { base, request } => {
                assert_eq!(base.session_ref, test_ref());
                assert_eq!(base.timestamp, TS);
                match request {
                    HostUiRequest::Notify {
                        request_id,
                        message,
                        level,
                    } => {
                        assert_eq!(request_id, "setModel-failed-2026-07-02T12-00-00-000Z");
                        assert_eq!(message, "Failed to set model: 500");
                        assert_eq!(level, Some(NotifyLevel::Error));
                    }
                    other => panic!("expected Notify, got {other:?}"),
                }
            }
            other => panic!("expected HostUiRequest, got {other:?}"),
        }
    }

    #[test]
    fn request_id_is_namespaced_by_operation() {
        let ev_a = error_notify(test_ref(), TS.to_string(), "setModel", "msg");
        let ev_b = error_notify(test_ref(), TS.to_string(), "setFacet", "msg");
        let req_a = match ev_a {
            SessionDriverEvent::HostUiRequest {
                request: HostUiRequest::Notify { request_id, .. },
                ..
            } => request_id,
            _ => panic!("expected HostUiRequest Notify"),
        };
        let req_b = match ev_b {
            SessionDriverEvent::HostUiRequest {
                request: HostUiRequest::Notify { request_id, .. },
                ..
            } => request_id,
            _ => panic!("expected HostUiRequest Notify"),
        };
        assert!(req_a.contains("setModel"));
        assert!(req_b.contains("setFacet"));
        assert_ne!(req_a, req_b);
    }

    #[tokio::test]
    async fn does_not_emit_on_success() {
        let emitted: std::sync::Mutex<Vec<SessionDriverEvent>> = std::sync::Mutex::new(Vec::new());
        let emit = |ev: SessionDriverEvent| emitted.lock().unwrap().push(ev);
        let now = || TS.to_string();

        with_error_notify(
            async { Ok::<_, Box<dyn std::error::Error + Send + Sync>>("ok") },
            &emit,
            test_ref(),
            &now,
            "setModel",
            "Failed to set model",
            None,
        )
        .await;

        assert!(emitted.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn emits_error_notify_on_rejection_with_error_message() {
        let emitted: std::sync::Mutex<Vec<SessionDriverEvent>> = std::sync::Mutex::new(Vec::new());
        let emit = |ev: SessionDriverEvent| emitted.lock().unwrap().push(ev);
        let now = || TS.to_string();

        let err: Box<dyn std::error::Error + Send + Sync> = "daemon unreachable".into();
        with_error_notify(
            async { Err::<(), _>(err) },
            &emit,
            test_ref(),
            &now,
            "setModel",
            "Failed to set model",
            None,
        )
        .await;

        let guard = emitted.lock().unwrap();
        assert_eq!(guard.len(), 1);
        match &guard[0] {
            SessionDriverEvent::HostUiRequest {
                request: HostUiRequest::Notify { message, level, .. },
                ..
            } => {
                assert_eq!(message, "Failed to set model: daemon unreachable");
                assert_eq!(*level, Some(NotifyLevel::Error));
            }
            other => panic!("expected HostUiRequest Notify, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn invokes_rollback_on_failure() {
        let emitted: std::sync::Mutex<Vec<SessionDriverEvent>> = std::sync::Mutex::new(Vec::new());
        let emit = |ev: SessionDriverEvent| emitted.lock().unwrap().push(ev);
        let now = || TS.to_string();
        let rolled_back = std::sync::Mutex::new(false);
        let rb = || *rolled_back.lock().unwrap() = true;

        let err: Box<dyn std::error::Error + Send + Sync> = "post failed".into();
        with_error_notify(
            async { Err::<(), _>(err) },
            &emit,
            test_ref(),
            &now,
            "setPermissionMonitor",
            "Failed to set permission monitor mode",
            Some(&rb),
        )
        .await;

        assert_eq!(emitted.lock().unwrap().len(), 1);
        assert!(*rolled_back.lock().unwrap());
    }

    #[tokio::test]
    async fn does_not_invoke_rollback_on_success() {
        let emitted: std::sync::Mutex<Vec<SessionDriverEvent>> = std::sync::Mutex::new(Vec::new());
        let emit = |ev: SessionDriverEvent| emitted.lock().unwrap().push(ev);
        let now = || TS.to_string();
        let rolled_back = std::sync::Mutex::new(false);
        let rb = || *rolled_back.lock().unwrap() = true;

        with_error_notify(
            async { Ok::<_, Box<dyn std::error::Error + Send + Sync>>("ok") },
            &emit,
            test_ref(),
            &now,
            "setPermissionMonitor",
            "Failed to set permission monitor mode",
            Some(&rb),
        )
        .await;

        assert!(emitted.lock().unwrap().is_empty());
        assert!(!*rolled_back.lock().unwrap());
    }
}
