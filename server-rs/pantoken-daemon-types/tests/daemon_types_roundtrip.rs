use pantoken_daemon_types::*;

#[test]
fn daemon_event_heartbeat_roundtrip() {
    let json = r#"{"type":"heartbeat","timestamp":"2025-01-01T00:00:00Z"}"#;
    let ev: DaemonEvent = serde_json::from_str(json).unwrap();
    match ev {
        DaemonEvent::Heartbeat { ref timestamp, .. } => {
            assert_eq!(timestamp, "2025-01-01T00:00:00Z");
        }
        _ => panic!("expected Heartbeat"),
    }
    let back = serde_json::to_string(&ev).unwrap();
    assert!(back.contains(r#""type":"heartbeat""#));
}

#[test]
fn daemon_event_content_block_delta_roundtrip() {
    let json = r#"{"type":"content_block_delta","block_index":0,"prompt_id":"p1","delta":{"type":"text","text":"hello"}}"#;
    let ev: DaemonEvent = serde_json::from_str(json).unwrap();
    match ev {
        DaemonEvent::ContentBlockDelta {
            block_index,
            prompt_id,
            ..
        } => {
            assert_eq!(block_index, 0);
            assert_eq!(prompt_id, "p1");
        }
        _ => panic!("expected ContentBlockDelta"),
    }
}

#[test]
fn sse_envelope_roundtrip() {
    let json = r#"{"seq":42,"emitted_at":"2025-01-01T00:00:00Z","session_id":"s1","event":{"type":"heartbeat","timestamp":"2025-01-01T00:00:00Z"}}"#;
    let env: SseEnvelope = serde_json::from_str(json).unwrap();
    assert_eq!(env.seq, Some(42));
    assert_eq!(env.session_id, "s1");
}

#[test]
fn health_response_roundtrip() {
    let json = r#"{"pid":12345,"session_id":"s1","port":8787,"project_path":"/home","started_at":"2025-01-01T00:00:00Z","last_heartbeat_at":"2025-01-01T00:00:00Z","parent_session_id":{"kind":"standalone"}}"#;
    let h: HealthResponse = serde_json::from_str(json).unwrap();
    assert_eq!(h.pid, 12345);
    assert_eq!(h.session_id, "s1");
}

#[test]
fn permission_monitor_mode_roundtrip() {
    let json = r#""standard""#;
    let mode: PermissionMonitorMode = serde_json::from_str(json).unwrap();
    assert_eq!(mode, PermissionMonitorMode::Standard);
    let back = serde_json::to_string(&mode).unwrap();
    assert_eq!(back, r#""standard""#);
}
