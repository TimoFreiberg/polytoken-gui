//! WS protocol envelope types — Rust port of `protocol/src/wire.ts`.
//!
//! `ClientMessage` and `ServerMessage` are the two directions of the pantoken
//! WebSocket protocol. Both use `type` as the serde tag with camelCase
//! variant names, matching the TS wire format exactly.

use serde::{Deserialize, Serialize};

use crate::session_driver::{
    AtRefs, BackgroundJob, CommandInfo, FileInfo, HostUiResponse, ImageContent,
    ModelCatalogDiagnostic, ModelDefaults, ModelOption, PermissionMonitorMode, SessionDriverEvent,
    SessionId, SessionListEntry,
};

// Must equal PROTOCOL_VERSION in protocol/src/wire.ts. 2→3: the nine
// settings/context ClientMessage variants collapsed into `sessionAction`, so a
// stale (v2) client's old-shape messages no longer deserialize — bump forces the
// client's hello-mismatch guard to fire instead of silently dropping them.
pub const PROTOCOL_VERSION: u32 = 3;

// ── PantokenSettings (server-side persisted settings) ──────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PantokenSettings {
    #[serde(rename = "loginShell")]
    pub login_shell: Option<String>,
    #[serde(rename = "backgroundModel")]
    pub background_model: Option<String>,
    #[serde(rename = "enabledExtensions", default)]
    pub enabled_extensions: Option<Vec<String>>,
}

// ── LoginEnvStatus ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginEnvStatus {
    #[serde(rename = "activeShell")]
    pub active_shell: Option<String>,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub detail: Option<String>,
}

// ── Trust ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustRequestOption {
    pub label: String,
    pub trusted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustRequest {
    #[serde(rename = "requestId")]
    pub request_id: String,
    pub cwd: String,
    pub title: String,
    pub options: Vec<TrustRequestOption>,
}

// ── DirListing / PathStat (defined in session_driver, re-exported) ─────
// These are in session_driver.rs already. wire.ts defines them locally but
// they're the same types — re-export from session_driver for the ServerMessage
// variants that flatten them.
pub use crate::session_driver::{DirListing, PathStat};

// ── SessionAttention ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionAttention {
    #[serde(rename = "sessionId")]
    pub session_id: SessionId,
    pub phase: SessionAttentionPhase,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub activity: Option<String>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        rename = "pendingCount"
    )]
    pub pending_count: Option<i64>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        rename = "pendingTitle"
    )]
    pub pending_title: Option<String>,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SessionAttentionPhase {
    Running,
    Waiting,
    Failed,
    Done,
}

// ── ResumeToken ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResumeToken {
    #[serde(rename = "sessionId")]
    pub session_id: SessionId,
    pub epoch: u64,
    pub seq: u64,
}

// ── ServerMessage ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(
    clippy::large_enum_variant,
    reason = "wire enum; big variant is the snapshot"
)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ServerMessage {
    Hello {
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
        #[serde(rename = "serverId")]
        server_id: String,
        #[serde(rename = "dataDir")]
        data_dir: String,
        #[serde(skip_serializing_if = "Option::is_none", default, rename = "buildSha")]
        build_sha: Option<String>,
    },
    /// Heartbeat reply to a client `Ping` — transport-level only (never folded or
    /// journaled), the same shape of message as `Hello`. The client's ws layer already
    /// treats ANY inbound frame as proof of liveness, so `Pong` carries no fields of its
    /// own; it exists purely to give a sent ping something to solicit.
    Pong,
    Seed {
        #[serde(rename = "sessionId")]
        session_id: Option<SessionId>,
        epoch: u64,
        seq: u64,
        events: Vec<SessionDriverEvent>,
    },
    Event {
        event: SessionDriverEvent,
        epoch: u64,
        seq: u64,
    },
    SessionList {
        sessions: Vec<SessionListEntry>,
        #[serde(rename = "activeSessionId")]
        active_session_id: Option<SessionId>,
        #[serde(rename = "defaultNewSessionCwd")]
        default_new_session_cwd: String,
    },
    SessionStatus {
        #[serde(rename = "runningIds")]
        running_ids: Vec<SessionId>,
        #[serde(
            skip_serializing_if = "Option::is_none",
            default,
            rename = "initializingIds"
        )]
        initializing_ids: Option<Vec<SessionId>>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        attention: Option<Vec<SessionAttention>>,
    },
    ModelList {
        models: Vec<ModelOption>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        diagnostic: Option<ModelCatalogDiagnostic>,
    },
    CommandList {
        commands: Vec<CommandInfo>,
    },
    FacetList {
        facets: Vec<String>,
    },
    JobsList {
        jobs: Vec<BackgroundJob>,
    },
    FileIndex {
        files: Vec<FileInfo>,
        #[serde(default)]
        truncated: bool,
    },
    /// `include_ignored` echoes the request's flag (Shift+Tab picker toggle) — a
    /// second staleness guard alongside `query`: a toggled request must not be
    /// satisfied by a stale untoggled response (or vice versa) racing back after
    /// the toggle flipped.
    FileList {
        query: String,
        files: Vec<FileInfo>,
        #[serde(
            skip_serializing_if = "Option::is_none",
            default,
            rename = "includeIgnored"
        )]
        include_ignored: Option<bool>,
    },
    /// Skills + subagents available for composer `@`-reference autocomplete.
    /// Server-authoritative like `FileIndex`; pushed on connect and re-pushed
    /// on session switch (session/cwd-scoped). See `AtRefs`.
    AtRefs {
        #[serde(flatten)]
        refs: AtRefs,
    },
    DirListing {
        #[serde(flatten)]
        listing: DirListing,
    },
    PathStat {
        #[serde(flatten)]
        stat: PathStat,
    },
    ModelDefaults {
        defaults: ModelDefaults,
    },
    PantokenSettings {
        settings: PantokenSettings,
        env: LoginEnvStatus,
        #[serde(rename = "pendingRestart")]
        pending_restart: bool,
        #[serde(
            skip_serializing_if = "Option::is_none",
            default,
            rename = "backgroundModelWarning"
        )]
        background_model_warning: Option<String>,
    },
    TrustRequest {
        #[serde(flatten)]
        request: TrustRequest,
    },
    TrustResolved {
        #[serde(rename = "requestId")]
        request_id: String,
    },
    UpdateStatus {
        available: bool,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        sha: Option<String>,
        applying: bool,
        #[serde(
            skip_serializing_if = "Option::is_none",
            default,
            rename = "desktopStale"
        )]
        desktop_stale: Option<bool>,
    },
    EditorPrefill {
        text: String,
    },
    PromptResult {
        #[serde(rename = "promptId")]
        prompt_id: String,
        accepted: bool,
        #[serde(skip_serializing_if = "Option::is_none", default, rename = "sessionId")]
        session_id: Option<SessionId>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        error: Option<String>,
    },
    QueueRestored {
        steering: Vec<String>,
        #[serde(rename = "followUp")]
        follow_up: Vec<String>,
    },
    WorktreeRetained {
        path: String,
        reason: String,
    },
    /// Correlated outcome for one stop attempt. `accepted` means the daemon accepted
    /// the request; a terminal driver event still settles the transcript.
    AbortResult {
        #[serde(skip_serializing_if = "Option::is_none", default, rename = "requestId")]
        request_id: Option<String>,
        accepted: bool,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        error: Option<String>,
    },
    Error {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        kind: Option<String>,
    },
}

// ── ClientMessage ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClientMessage {
    Hello {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        auth: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        resume: Option<ResumeToken>,
    },
    Prompt {
        #[serde(skip_serializing_if = "Option::is_none", default, rename = "promptId")]
        prompt_id: Option<String>,
        text: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        images: Option<Vec<ImageContent>>,
        #[serde(skip_serializing_if = "Option::is_none", default, rename = "deliverAs")]
        deliver_as: Option<DeliveryMode>,
        #[serde(skip_serializing_if = "Option::is_none", default, rename = "sessionId")]
        session_id: Option<SessionId>,
    },
    Abort {
        #[serde(skip_serializing_if = "Option::is_none", default, rename = "requestId")]
        request_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default, rename = "sessionId")]
        session_id: Option<SessionId>,
    },
    RestoreQueue {
        #[serde(skip_serializing_if = "Option::is_none", default, rename = "sessionId")]
        session_id: Option<SessionId>,
    },
    RespondUi {
        response: HostUiResponse,
        #[serde(skip_serializing_if = "Option::is_none", default, rename = "sessionId")]
        session_id: Option<SessionId>,
    },
    /// The data-driven envelope for fire-and-forget session actions that share
    /// one shape (a daemon POST; updated state arrives via later events).
    /// Adding an action = one `SessionAction` variant + one arm per driver.
    SessionAction {
        action: SessionAction,
        #[serde(skip_serializing_if = "Option::is_none", default, rename = "sessionId")]
        session_id: Option<SessionId>,
    },
    SetLoginShell {
        path: Option<String>,
    },
    SetBackgroundModel {
        spec: Option<String>,
    },
    OpenSession {
        path: String,
    },
    ReloadSession {
        path: String,
    },
    Branch {
        #[serde(rename = "entryId")]
        entry_id: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        summarize: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none", default, rename = "sessionId")]
        session_id: Option<SessionId>,
    },
    NewSession {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        cwd: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        worktree: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        model: Option<NewSessionModel>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        thinking: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        facet: Option<String>,
        #[serde(
            skip_serializing_if = "Option::is_none",
            default,
            rename = "permissionMonitor"
        )]
        permission_monitor: Option<PermissionMonitorMode>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        prompt: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default, rename = "promptId")]
        prompt_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        images: Option<Vec<ImageContent>>,
    },
    ListSessions,
    SetArchived {
        path: String,
        archived: bool,
    },
    RenameSession {
        path: String,
        name: String,
    },
    CleanupWorktree {
        path: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        force: Option<bool>,
    },
    /// Detach from a session: release Pantoken's TUI attachment lease so an
    /// external client (terminal polytoken CLI) can take over. The daemon
    /// stays alive; the session reappears as idle in the sidebar. Only
    /// meaningful for the polytoken driver; the mock/default is a no-op.
    DetachSession {
        path: String,
    },
    ListCommands,
    ListFacets,
    FetchJobs,
    DeleteTodo {
        id: i64,
    },
    /// `include_ignored`: the picker's Shift+Tab toggle — when true, hidden
    /// dotfiles and gitignored entries are included too (project AND external
    /// browsing), bypassing the normal ignore-file filtering. Absent/false is
    /// the default (filtered) behavior.
    QueryFiles {
        query: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        cwd: Option<String>,
        #[serde(
            skip_serializing_if = "Option::is_none",
            default,
            rename = "includeIgnored"
        )]
        include_ignored: Option<bool>,
    },
    QueryDir {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        path: Option<String>,
    },
    StatPath {
        path: String,
    },
    TrustResponse {
        #[serde(rename = "requestId")]
        request_id: String,
        choice: Option<i64>,
    },
    ApplyUpdate,
    ForceUpdate,
    RequestSeed {
        #[serde(skip_serializing_if = "Option::is_none", default, rename = "sessionId")]
        session_id: Option<SessionId>,
    },
    Mock {
        script: String,
    },
    OpenDataDir,
    /// Heartbeat probe: sent on an interval while connected (and once immediately on a
    /// wake — tab foregrounded, bfcache restore, network back online) to catch a
    /// half-open socket that TCP itself may never surface (phone slept, NAT dropped the
    /// stream, no FIN/RST ever arrives). The hub replies with `Pong`; the client
    /// actually treats ANY inbound frame as liveness, so this mostly exists to solicit
    /// one on a schedule.
    Ping,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DeliveryMode {
    Steer,
    FollowUp,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum McpAction {
    Enable,
    Disable,
    Disconnect,
    Reconnect,
}

/// The fire-and-forget pass-through actions carried by
/// `ClientMessage::SessionAction`. They share one lifecycle: POST to the
/// daemon, no direct reply — the effect arrives as later driver events
/// (snapshots, notifications, usage updates).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SessionAction {
    ToggleAdventurousHandoff,
    SetNotificationAutodrain {
        enabled: bool,
    },
    Compact,
    ClearContext,
    SetMcpServer {
        #[serde(rename = "serverName")]
        server_name: String,
        action: McpAction,
    },
    SetModel {
        provider: String,
        #[serde(rename = "modelId")]
        model_id: String,
    },
    SetThinking {
        level: String,
    },
    SetFacet {
        facet: String,
    },
    SetPermissionMonitor {
        mode: PermissionMonitorMode,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewSessionModel {
    pub provider: String,
    #[serde(rename = "modelId")]
    pub model_id: String,
}

// ── Parse helpers (match wire.ts parseClientMessage/parseServerMessage) ─

/// Parse a raw JSON string into a ClientMessage. Returns None on parse failure
/// or if the `type` field is missing/non-string — matching the TS behavior.
pub fn parse_client_message(raw: &str) -> Option<ClientMessage> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    if v.is_object() && v.get("type")?.as_str().is_some() {
        serde_json::from_value(v).ok()
    } else {
        None
    }
}

/// Parse a raw JSON string into a ServerMessage. Returns None on parse failure.
pub fn parse_server_message(raw: &str) -> Option<ServerMessage> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    if v.is_object() && v.get("type")?.as_str().is_some() {
        serde_json::from_value(v).ok()
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_driver::{SessionRef, Timestamp};

    fn make_session_ref() -> SessionRef {
        SessionRef {
            workspace_id: "ws1".into(),
            session_id: "s1".into(),
        }
    }

    #[test]
    fn roundtrip_hello() {
        let msg = ClientMessage::Hello {
            auth: Some("token".into()),
            resume: Some(ResumeToken {
                session_id: "s1".into(),
                epoch: 1,
                seq: 5,
            }),
        };
        let json = serde_json::to_string(&msg).unwrap();
        let parsed: ClientMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ClientMessage::Hello { auth, resume } => {
                assert_eq!(auth, Some("token".to_string()));
                assert_eq!(resume.unwrap().seq, 5);
            }
            _ => panic!("expected Hello"),
        }
    }

    #[test]
    fn roundtrip_prompt() {
        let json_str = r#"{
            "type": "prompt",
            "promptId": "p1",
            "text": "Hello world",
            "sessionId": "s1"
        }"#;
        let msg = parse_client_message(json_str).unwrap();
        match msg {
            ClientMessage::Prompt {
                prompt_id,
                text,
                session_id,
                ..
            } => {
                assert_eq!(prompt_id, Some("p1".to_string()));
                assert_eq!(text, "Hello world");
                assert_eq!(session_id, Some("s1".to_string()));
            }
            _ => panic!("expected Prompt"),
        }
    }

    #[test]
    fn roundtrip_server_event() {
        let ev = SessionDriverEvent::SessionReset {
            base: crate::session_driver::SessionEventBase {
                session_ref: make_session_ref(),
                timestamp: Timestamp::from("2026-07-03T12:00:00Z"),
                run_id: None,
            },
        };
        let msg = ServerMessage::Event {
            event: ev,
            epoch: 1,
            seq: 3,
        };
        let json = serde_json::to_string(&msg).unwrap();
        let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ServerMessage::Event { epoch, seq, .. } => {
                assert_eq!(epoch, 1);
                assert_eq!(seq, 3);
            }
            _ => panic!("expected Event"),
        }
    }

    #[test]
    fn roundtrip_server_seed() {
        let json_str = r#"{
            "type": "seed",
            "sessionId": "s1",
            "epoch": 0,
            "seq": 0,
            "events": []
        }"#;
        let msg: ServerMessage = serde_json::from_str(json_str).unwrap();
        match msg {
            ServerMessage::Seed {
                session_id, events, ..
            } => {
                assert_eq!(session_id, Some("s1".to_string()));
                assert!(events.is_empty());
            }
            _ => panic!("expected Seed"),
        }
    }

    #[test]
    fn at_refs_serializes_flattened_not_nested_under_refs() {
        // `AtRefs { refs: AtRefs }` uses `#[serde(flatten)]` precisely so `refs`
        // never appears as a JSON key — regression guard for that flatten (a
        // dropped `#[serde(flatten)]` would silently nest `skills`/`subagents`
        // one level deeper and the client's `atRefs` fold would stop matching).
        let msg = ServerMessage::AtRefs {
            refs: AtRefs {
                skills: vec!["debug".to_string(), "journal".to_string()],
                subagents: vec!["reviewer".to_string()],
            },
        };
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "type": "atRefs",
                "skills": ["debug", "journal"],
                "subagents": ["reviewer"],
            })
        );

        let parsed: ServerMessage = serde_json::from_value(json).unwrap();
        match parsed {
            ServerMessage::AtRefs { refs } => {
                assert_eq!(
                    refs.skills,
                    vec!["debug".to_string(), "journal".to_string()]
                );
                assert_eq!(refs.subagents, vec!["reviewer".to_string()]);
            }
            _ => panic!("expected AtRefs"),
        }
    }

    #[test]
    fn query_files_include_ignored_omitted_when_absent_present_when_set() {
        // Regression guard for the Shift+Tab ignore-toggle plumbing: `includeIgnored`
        // must round-trip as an omitted key (not `null`) when unset, matching the TS
        // `includeIgnored?: boolean` — an older server/client pair that never sends
        // the field must not choke on a missing key.
        let without = ClientMessage::QueryFiles {
            query: "foo".into(),
            cwd: None,
            include_ignored: None,
        };
        let json = serde_json::to_value(&without).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "type": "queryFiles", "query": "foo" })
        );

        let with_flag = ClientMessage::QueryFiles {
            query: "foo".into(),
            cwd: None,
            include_ignored: Some(true),
        };
        let json = serde_json::to_value(&with_flag).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "type": "queryFiles", "query": "foo", "includeIgnored": true })
        );

        let parsed: ClientMessage = serde_json::from_value(json).unwrap();
        match parsed {
            ClientMessage::QueryFiles {
                include_ignored, ..
            } => {
                assert_eq!(include_ignored, Some(true));
            }
            _ => panic!("expected QueryFiles"),
        }
    }

    #[test]
    fn file_list_echoes_include_ignored() {
        // `fileList`'s echoed flag is the staleness guard alongside `query`: a
        // toggled request must not be satisfied by a stale untoggled response.
        let msg = ServerMessage::FileList {
            query: "foo".into(),
            files: vec![],
            include_ignored: Some(true),
        };
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "type": "fileList",
                "query": "foo",
                "files": [],
                "includeIgnored": true,
            })
        );

        let parsed: ServerMessage = serde_json::from_value(json).unwrap();
        match parsed {
            ServerMessage::FileList {
                include_ignored, ..
            } => {
                assert_eq!(include_ignored, Some(true));
            }
            _ => panic!("expected FileList"),
        }
    }

    #[test]
    fn roundtrip_server_session_list() {
        let json_str = r#"{
            "type": "sessionList",
            "sessions": [],
            "activeSessionId": null,
            "defaultNewSessionCwd": "/home"
        }"#;
        let msg: ServerMessage = serde_json::from_str(json_str).unwrap();
        match msg {
            ServerMessage::SessionList {
                default_new_session_cwd,
                ..
            } => {
                assert_eq!(default_new_session_cwd, "/home");
            }
            _ => panic!("expected SessionList"),
        }
    }

    #[test]
    fn roundtrip_new_session() {
        let json_str = r#"{
            "type": "newSession",
            "cwd": "/home/project",
            "worktree": true,
            "model": {"provider": "anthropic", "modelId": "claude-4"},
            "thinking": "high",
            "prompt": "Build something"
        }"#;
        let msg = parse_client_message(json_str).unwrap();
        match msg {
            ClientMessage::NewSession {
                cwd,
                worktree,
                model,
                thinking,
                prompt,
                ..
            } => {
                assert_eq!(cwd, Some("/home/project".to_string()));
                assert_eq!(worktree, Some(true));
                assert_eq!(model.unwrap().model_id, "claude-4");
                assert_eq!(thinking, Some("high".to_string()));
                assert_eq!(prompt, Some("Build something".to_string()));
            }
            _ => panic!("expected NewSession"),
        }
    }

    #[test]
    fn roundtrip_session_action_set_mcp_server() {
        let json_str = r#"{
            "type": "sessionAction",
            "action": {
                "kind": "setMcpServer",
                "serverName": "my-server",
                "action": "reconnect"
            }
        }"#;
        let msg = parse_client_message(json_str).unwrap();
        match msg {
            ClientMessage::SessionAction {
                action:
                    SessionAction::SetMcpServer {
                        server_name,
                        action,
                    },
                ..
            } => {
                assert_eq!(server_name, "my-server");
                assert_eq!(action, McpAction::Reconnect);
            }
            _ => panic!("expected SessionAction::SetMcpServer"),
        }
    }

    #[test]
    fn roundtrip_session_action_payload_free_kinds() {
        for (json_kind, expected) in [
            ("compact", SessionAction::Compact),
            ("clearContext", SessionAction::ClearContext),
            (
                "toggleAdventurousHandoff",
                SessionAction::ToggleAdventurousHandoff,
            ),
        ] {
            let json_str = format!(
                r#"{{"type": "sessionAction", "action": {{"kind": "{json_kind}"}}, "sessionId": "s1"}}"#
            );
            let msg = parse_client_message(&json_str).unwrap();
            match msg {
                ClientMessage::SessionAction { action, session_id } => {
                    assert_eq!(action, expected);
                    assert_eq!(session_id.as_deref(), Some("s1"));
                }
                _ => panic!("expected SessionAction for kind {json_kind}"),
            }
        }
    }

    #[test]
    fn roundtrip_trust_response() {
        let json_str = r#"{
            "type": "trustResponse",
            "requestId": "r1",
            "choice": 0
        }"#;
        let msg = parse_client_message(json_str).unwrap();
        match msg {
            ClientMessage::TrustResponse { request_id, choice } => {
                assert_eq!(request_id, "r1");
                assert_eq!(choice, Some(0));
            }
            _ => panic!("expected TrustResponse"),
        }
    }

    #[test]
    fn parse_invalid_json_returns_none() {
        assert!(parse_client_message("not json").is_none());
        assert!(parse_client_message(r#"{"type": 42}"#).is_none());
        assert!(parse_client_message(r#"{"noType": true}"#).is_none());
    }

    #[test]
    fn roundtrip_server_hello() {
        let json_str = r#"{
            "type": "hello",
            "protocolVersion": 2,
            "serverId": "srv-abc",
            "dataDir": "/data"
        }"#;
        let msg: ServerMessage = serde_json::from_str(json_str).unwrap();
        match msg {
            ServerMessage::Hello {
                protocol_version,
                server_id,
                data_dir,
                ..
            } => {
                assert_eq!(protocol_version, 2);
                assert_eq!(server_id, "srv-abc");
                assert_eq!(data_dir, "/data");
            }
            _ => panic!("expected Hello"),
        }
    }

    #[test]
    fn roundtrip_server_model_defaults() {
        let json_str = r#"{
            "type": "modelDefaults",
            "defaults": {"favorites": ["anthropic/claude-4"]}
        }"#;
        let msg: ServerMessage = serde_json::from_str(json_str).unwrap();
        match msg {
            ServerMessage::ModelDefaults { defaults } => {
                assert_eq!(defaults.favorites, vec!["anthropic/claude-4"]);
            }
            _ => panic!("expected ModelDefaults"),
        }
    }

    #[test]
    fn roundtrip_server_model_list_diagnostic() {
        let json_str = r#"{
            "type": "modelList",
            "models": [],
            "diagnostic": {
                "kind": "couldNotBeParsed",
                "message": "no model entries"
            }
        }"#;
        let msg: ServerMessage = serde_json::from_str(json_str).unwrap();
        match msg {
            ServerMessage::ModelList { models, diagnostic } => {
                assert!(models.is_empty());
                assert!(matches!(
                    diagnostic,
                    Some(ModelCatalogDiagnostic::CouldNotBeParsed { message })
                        if message == "no model entries"
                ));
            }
            _ => panic!("expected ModelList"),
        }
    }

    #[test]
    fn roundtrip_server_model_list_other_diagnostics() {
        for kind in ["emptyOutput", "noResponse"] {
            let json = format!(
                r#"{{"type":"modelList","models":[],"diagnostic":{{"kind":"{kind}","message":"diagnostic"}}}}"#
            );
            let msg: ServerMessage = serde_json::from_str(&json).unwrap();
            match msg {
                ServerMessage::ModelList { diagnostic, .. } => {
                    assert_eq!(
                        diagnostic.as_ref().map(|d| match d {
                            ModelCatalogDiagnostic::EmptyOutput { .. } => "emptyOutput",
                            ModelCatalogDiagnostic::NoResponse { .. } => "noResponse",
                            ModelCatalogDiagnostic::CouldNotBeParsed { .. } => "couldNotBeParsed",
                        }),
                        Some(kind)
                    );
                }
                _ => panic!("expected ModelList"),
            }
        }
    }

    #[test]
    fn roundtrip_branch() {
        let json_str = r#"{
            "type": "branch",
            "entryId": "e1",
            "summarize": true
        }"#;
        let msg = parse_client_message(json_str).unwrap();
        match msg {
            ClientMessage::Branch {
                entry_id,
                summarize,
                ..
            } => {
                assert_eq!(entry_id, "e1");
                assert_eq!(summarize, Some(true));
            }
            _ => panic!("expected Branch"),
        }
    }

    #[test]
    fn roundtrip_server_error() {
        let json_str = r#"{
            "type": "error",
            "message": "Something went wrong",
            "kind": "session-switch"
        }"#;
        let msg: ServerMessage = serde_json::from_str(json_str).unwrap();
        match msg {
            ServerMessage::Error { message, kind } => {
                assert_eq!(message, "Something went wrong");
                assert_eq!(kind, Some("session-switch".to_string()));
            }
            _ => panic!("expected Error"),
        }
    }

    #[test]
    fn roundtrip_abort_result() {
        let json_str = r#"{
            "type": "abortResult",
            "requestId": "stop-1",
            "accepted": false,
            "error": "daemon did not receive stop"
        }"#;
        let msg: ServerMessage = serde_json::from_str(json_str).unwrap();
        match msg {
            ServerMessage::AbortResult {
                request_id,
                accepted,
                error,
            } => {
                assert_eq!(request_id.as_deref(), Some("stop-1"));
                assert!(!accepted);
                assert_eq!(error.as_deref(), Some("daemon did not receive stop"));
            }
            _ => panic!("expected AbortResult"),
        }
    }

    #[test]
    fn roundtrip_server_pantoken_settings() {
        let json_str = r#"{
            "type": "pantokenSettings",
            "settings": {"loginShell": null, "backgroundModel": null, "enabledExtensions": null},
            "env": {"activeShell": "/bin/zsh", "ok": true},
            "pendingRestart": false
        }"#;
        let msg: ServerMessage = serde_json::from_str(json_str).unwrap();
        match msg {
            ServerMessage::PantokenSettings {
                pending_restart, ..
            } => {
                assert!(!pending_restart);
            }
            _ => panic!("expected PantokenSettings"),
        }
    }

    #[test]
    fn roundtrip_ping() {
        let json_str = r#"{"type": "ping"}"#;
        let msg = parse_client_message(json_str).unwrap();
        assert!(matches!(msg, ClientMessage::Ping));
    }

    #[test]
    fn roundtrip_server_pong() {
        let msg = ServerMessage::Pong;
        let json = serde_json::to_string(&msg).unwrap();
        assert_eq!(json, r#"{"type":"pong"}"#);
        let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
        assert!(matches!(parsed, ServerMessage::Pong));
    }

    #[test]
    fn roundtrip_server_queue_restored() {
        let json_str = r#"{
            "type": "queueRestored",
            "steering": ["msg1"],
            "followUp": ["msg2"]
        }"#;
        let msg: ServerMessage = serde_json::from_str(json_str).unwrap();
        match msg {
            ServerMessage::QueueRestored {
                steering,
                follow_up,
            } => {
                assert_eq!(steering, vec!["msg1"]);
                assert_eq!(follow_up, vec!["msg2"]);
            }
            _ => panic!("expected QueueRestored"),
        }
    }
}
