// The real driver: keeps N independent pi AgentSessions warm and presents them through
// PilotDriver, the same seam the mock implements. Selected via PILOT_DRIVER=pi. Uses the
// user's existing pi config (model + credentials from ~/.pi) unless overridden.
//
// D8 increment 2: instead of a single runtime that disposes the old session on every
// switch, we hold a `Map<sessionId, WarmSession>` of fully-independent sessions, each with
// its own cwd-bound services (trust resolver per cwd), UI bridge, and event subscription.
// They all stream concurrently into the shared `emit`; every event carries its session's
// ref, so the hub folds only the focused one but still lets a background run notify a
// closed phone. `openSession`/`newSession` warm-and-focus (create on first touch, reuse
// after); `prompt`/`abort`/`respondUi` dispatch by sessionId. Nothing is disposed on a
// switch — a backgrounded session keeps running and is instantly re-focusable with its
// full transcript. A warm-cap (PILOT_WARM_CAP, default 8) bounds the pool: when warming
// a session would exceed it, the least-recently-focused victims are disposed (see the
// eviction loop in warmUp). Disposing aborts any in-flight run, so eviction emits a
// synthetic sessionClosed for each victim to clear the hub's cross-session running set.
//
// This replaces the old runtime-swap model: AgentSessionRuntime exists precisely to
// replace+dispose the active session, which is the opposite of keeping N warm.

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  type AgentSession,
  AuthStorage,
  createAgentSessionFromServices,
  createAgentSessionServices,
  type ExtensionUIContext,
  getAgentDir,
  ModelRegistry,
  type SessionEntry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  CommandInfo,
  DirListing,
  FileInfo,
  HostUiResponse,
  ModelDefaults,
  ProviderInfo,
  SessionDriverEvent,
  SessionId,
  SessionListEntry,
  SessionRef,
  SessionSnapshot,
  SessionStatus,
  SessionUsage,
} from "@pilot/protocol";
import { ArchiveStore } from "../archive-store.js";
import { config } from "../config.js";
import type {
  NewSessionOpts,
  OAuthLoginIO,
  PilotDriver,
  TrustEvent,
} from "../driver.js";
import { correlateEntryIds } from "./branch-ids.js";
import { mapPiEvent } from "./event-map.js";
import { queueMessages } from "./queue-map.js";
import { projectTree } from "./tree-map.js";
import {
  contentToText,
  type HistoryMessage,
  historyToEvents,
} from "./history-map.js";
import { createWorktree, removeWorktree } from "./worktree.js";
import { WorktreeStore } from "../worktree-store.js";
import { evictionPlan } from "./warm-cap.js";
import {
  type AuthCred,
  apiKeySetupSupported,
  inferAuthSource,
  mergeFavoritePatterns,
  type ModelLike,
  resolveFavorites,
} from "./model-config.js";
import { firstUserPreview, mergeSessionLists } from "./session-list.js";
import { makeTrustResolver, type TrustAsk } from "./trust.js";
import { PiUiBridge } from "./ui-bridge.js";
import { parseUnsupportedHostUiErrorMessage } from "./unsupported-host-ui.js";
import { countUserMessages } from "./user-message-count.js";

export interface PiDriverOptions {
  /** Max kept-warm sessions before LRU eviction. Defaults to config.warmCap. */
  warmCap?: number;
}

// pi's thinking-level ladder. Mirrors `getSupportedThinkingLevels` from
// @earendil-works/pi-ai, which isn't a direct/resolvable dep here — we read the same
// `reasoning` + `thinkingLevelMap` model metadata it does. Used to enrich the model
// list so the new-session draft's effort picker has accurate options before a session
// exists (per-session `availableThinkingLevels` is only known once a model is warm).
const EXTENDED_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
function supportedThinkingLevels(model: {
  reasoning?: unknown;
  thinkingLevelMap?: Record<string, string | null | undefined>;
}): string[] {
  if (!model.reasoning) return ["off"];
  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh") return mapped !== undefined;
    return true;
  });
}

// One kept-warm session and everything bound to it. Fully independent: its own
// AgentSession, UI bridge, and event subscription. `ref`/`cwd` are fixed for the
// session's lifetime — there is no swap, so nothing here is ever rebound.
interface WarmSession {
  session: AgentSession;
  ref: SessionRef;
  cwd: string;
  bridge: PiUiBridge;
  unsubscribe: () => void;
}

/** `fd` matches its pattern as a regex by default, so a raw query is wrong twice over:
 *  path chars like `.` become wildcards, and unbalanced metacharacters (`(`, `[`) make
 *  `fd` exit non-zero — a file literally named `foo[1].txt` would be uncompletable. Port
 *  pi's escaping: regex-escape each path segment, joining on a separator class. Mirrors
 *  `escapeRegex`/`buildFdPathQuery` in pi's TUI `autocomplete.ts`. */
function escapeFdRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildFdPathQuery(query: string): string {
  const normalized = query.replace(/\\/g, "/");
  if (!normalized.includes("/")) {
    return escapeFdRegex(normalized);
  }
  const hasTrailingSeparator = normalized.endsWith("/");
  const trimmed = normalized.replace(/^\/+|\/+$/g, "");
  if (!trimmed) return normalized;
  const separatorPattern = "[\\\\/]";
  const segments = trimmed.split("/").filter(Boolean).map(escapeFdRegex);
  if (segments.length === 0) return normalized;
  let pattern = segments.join(separatorPattern);
  if (hasTrailingSeparator) pattern += separatorPattern;
  return pattern;
}

/** How many entries the prefetched @-mention index carries. The client fuzzy-matches
 *  this locally (no per-keystroke round-trip); only when a cwd overflows the cap does it
 *  fall back to a server `fd` search. Generous — `fd` is .gitignore-aware so the count is
 *  source files, not vendored trees — but bounded so the per-switch payload stays small. */
const FILE_INDEX_CAP = 2000;
/** Result cap for the per-query fallback search (only fires on a truncated index). */
const FILE_QUERY_CAP = 50;

/** Shared fd flags for both the index and the fallback query: cap results, list files +
 *  dirs, follow symlinks, include dotfiles, exclude the `.git` tree. `.gitignore`-aware
 *  by default. Mirrors pi's TUI `autocomplete.ts`. */
function baseFdArgs(cwd: string, maxResults: number): string[] {
  return [
    "--base-directory",
    cwd,
    "--max-results",
    String(maxResults),
    "--type",
    "f",
    "--type",
    "d",
    "--follow",
    "--hidden",
    "--exclude",
    ".git",
    "--exclude",
    ".git/*",
    "--exclude",
    ".git/**",
  ];
}

/** Spawn fd and collect its stdout lines. Resolves `[]` on spawn failure, non-zero exit
 *  (fd exits 1 when nothing matches), or a 5s timeout — silence is fine in a web UI (the
 *  menu just stays closed / the index stays empty). */
function runFd(cwd: string, args: string[]): Promise<string[]> {
  return new Promise((resolve) => {
    const child = Bun.spawn(["fd", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill();
        resolve([]);
      }
    }, 5_000);

    const finish = (lines: string[]) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(lines);
    };

    void (async () => {
      let stdout = "";
      try {
        stdout = await new Response(child.stdout).text();
      } catch {
        // fd not found or errored — return empty.
        finish([]);
        return;
      }
      const exitCode = await child.exited;
      if (exitCode !== 0) {
        // fd exits 1 when no matches; treat like empty.
        finish([]);
        return;
      }
      finish(stdout.trim().split("\n").filter(Boolean));
    })();
  });
}

/** Parse fd's path lines into `FileInfo[]`: normalize separators to forward slashes,
 *  strip fd's trailing "/" on directories, and drop any stray `.git` entries (fd's
 *  exclude should catch them — belt-and-suspenders). */
function parseFdLines(lines: string[]): FileInfo[] {
  const results: FileInfo[] = [];
  for (const line of lines) {
    const normalized = line.replaceAll("\\", "/");
    const isDirectory = normalized.endsWith("/");
    const path = isDirectory ? normalized.slice(0, -1) : normalized;
    if (
      path === ".git" ||
      path.startsWith(".git/") ||
      path.includes("/.git/")
    ) {
      continue;
    }
    results.push({ path, isDirectory });
  }
  return results;
}

/** Build the full @-mention index for `cwd`: one unfiltered fd over the tree, capped at
 *  {@link FILE_INDEX_CAP}. Requests one extra entry so we can report `truncated` when the
 *  cwd overflows the cap (the client then falls back to {@link listFilesWithFd}). */
async function listFileIndexWithFd(
  cwd: string,
): Promise<{ files: FileInfo[]; truncated: boolean }> {
  const files = parseFdLines(
    await runFd(cwd, baseFdArgs(cwd, FILE_INDEX_CAP + 1)),
  );
  const truncated = files.length > FILE_INDEX_CAP;
  return {
    files: truncated ? files.slice(0, FILE_INDEX_CAP) : files,
    truncated,
  };
}

/** Fallback @-mention search in `cwd` via fd, used only when the index was truncated.
 *  `fd` matches as a regex, so the query is escaped via `buildFdPathQuery` (see above);
 *  `--full-path` is added for path-bearing queries. Capped at {@link FILE_QUERY_CAP}. */
async function listFilesWithFd(
  cwd: string,
  query: string,
): Promise<FileInfo[]> {
  const args = baseFdArgs(cwd, FILE_QUERY_CAP);
  if (query.replace(/\\/g, "/").includes("/")) {
    args.push("--full-path");
  }
  if (query) {
    args.push(buildFdPathQuery(query));
  }
  return parseFdLines(await runFd(cwd, args));
}

/** Expand a GUI-supplied path to an absolute one: `~`/`~/…` -> $HOME, otherwise resolve
 *  relative segments. `~otheruser` is left literal (we can't resolve another user's home)
 *  and falls through to the caller's existence check. Shared by {@link createPiDriver}'s
 *  `newSession` and `listDir` so both expand paths identically. */
function resolveGuiPath(raw: string): string {
  const trimmed = raw.trim();
  const expanded =
    trimmed === "~" || trimmed.startsWith("~/")
      ? resolve(homedir(), `.${trimmed.slice(1)}`)
      : trimmed;
  return resolve(expanded);
}

/** Sort directory basenames for the picker: non-hidden first, then case-insensitive. */
function compareDirNames(a: string, b: string): number {
  const aHidden = a.startsWith(".");
  const bHidden = b.startsWith(".");
  if (aHidden !== bHidden) return aHidden ? 1 : -1;
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

/** List the child directories of an absolute `dir` on the real filesystem (the
 *  new-session picker). Symlinks are followed so a symlinked project dir still shows.
 *  An unreadable `dir` (missing / not a directory / no permission) returns `error: true`
 *  with no entries — surfaced to the UI rather than masquerading as an empty folder. */
function listDirOnDisk(dir: string): DirListing {
  const parent = dirname(dir);
  const parentOrNull = parent === dir ? null : parent;
  let dirents: ReturnType<typeof readdirSync<{ withFileTypes: true }>>;
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { path: dir, parent: parentOrNull, entries: [], error: true };
  }
  const entries: string[] = [];
  for (const d of dirents) {
    let isDir = d.isDirectory();
    if (!isDir && d.isSymbolicLink()) {
      // dirent.isDirectory() is false for a symlink even when it points at a dir;
      // stat the target (follows the link) so symlinked project dirs still list.
      try {
        isDir = statSync(join(dir, d.name)).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (isDir) entries.push(d.name);
  }
  entries.sort(compareDirNames);
  return { path: dir, parent: parentOrNull, entries };
}

export async function createPiDriver(
  opts: PiDriverOptions = {},
): Promise<PilotDriver> {
  // The server's own cwd carries no operator intent (a Finder-launched desktop app
  // starts in `/`; even `bun run dev` is run from the repo, not the project you want
  // to work in), so it must NOT feed any logic: not trust (no dir is implicitly
  // trusted — every cwd goes through pi's built-in trust: trust.json → interactive
  // card → deny-safe), not the initial session (boot to an empty landing, not a
  // session at the server cwd), and not the new-session default ($HOME). See D12.
  const agentDir = getAgentDir();
  const now = () => String(Date.now());

  // Pilot-side archive index (source of truth for the archived flag; see ArchiveStore).
  // Read at list time as an in-memory lookup — no per-session file reads.
  const archiveStore = new ArchiveStore();

  // Pilot-side worktree index: the jj/git worktrees pilot created (keyed by cwd), so the
  // sidebar can flag them and cleanup only ever touches worktrees we own.
  const worktreeStore = new WorktreeStore();

  // ONE shared auth store + model registry across every warm session. Both are global
  // (auth.json + models.json under agentDir, cwd-independent), and sharing them is what
  // lets the Settings panel's provider/key changes take effect everywhere: a key saved
  // here + `modelRegistry.refresh()` immediately updates each warm session's available
  // models (and `setModel`'s `find`). Per-session settings managers stay cwd-bound (they
  // layer project settings at session creation); for the GLOBAL defaults/favorites the
  // panel edits we keep a separate cwd-independent manager (projectTrusted:false) —
  // so the bound cwd doesn't matter for what we read/write.
  const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
  const modelRegistry = ModelRegistry.create(
    authStorage,
    join(agentDir, "models.json"),
  );
  // Global settings only: pass projectTrusted:false so the project-scope settings
  // file at the (irrelevant) cwd is never loaded — this manager is cwd-independent.
  const globalSettings = SettingsManager.create(homedir(), agentDir, {
    projectTrusted: false,
  });

  // Available models as the small shape model-config helpers want.
  const availableModelLikes = (): ModelLike[] => {
    modelRegistry.refresh();
    return modelRegistry
      .getAvailable()
      .map((m) => ({ provider: String(m.provider), id: m.id }));
  };

  const listeners = new Set<(ev: SessionDriverEvent) => void>();
  const emit = (ev: SessionDriverEvent) => {
    for (const l of listeners) {
      try {
        l(ev);
      } catch (e) {
        console.error("[pi] listener error", e);
      }
    }
  };

  // --- Host-level project-trust channel (D12 interactive card) ---
  // Trust resolves inside warmUp's createAgentSessionServices — before the session (and
  // its PiUiBridge) exists, and while the hub is mid-swap (switching=true) suppressing
  // session events. So the card can't ride the per-session stream. It travels here
  // instead: makeTrustResolver's `ask` blocks (pi awaits resolveProjectTrust, exactly as
  // its TUI blocks on ui.select) until a client answers via respondTrust, or it denies
  // deny-safe on timeout / no client. Per-cwd, not per-session, by nature.
  const trustListeners = new Set<(ev: TrustEvent) => void>();
  const emitTrust = (ev: TrustEvent) => {
    for (const l of trustListeners) {
      try {
        l(ev);
      } catch (e) {
        console.error("[pi] trust listener error", e);
      }
    }
  };
  const pendingTrust = new Map<
    string,
    {
      resolve: (choice: number | null) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let trustSeq = 0;
  // Disambiguates live user-message ids within a millisecond: `u-${now()}` alone
  // collides on a fast double-send, and Transcript.svelte keys its {#each} by id.
  let userSeq = 0;
  // Generous: the operator may be answering from a pocket. On expiry, deny-safe.
  const TRUST_TIMEOUT_MS = 5 * 60_000;

  const settleTrust = (requestId: string, choice: number | null): void => {
    const p = pendingTrust.get(requestId);
    if (!p) return; // already settled / unknown
    pendingTrust.delete(requestId);
    clearTimeout(p.timer);
    emitTrust({ kind: "resolved", requestId });
    p.resolve(choice);
  };

  const ask: TrustAsk = ({ cwd, title, options }) =>
    new Promise<number | null>((resolve) => {
      // No one to answer (e.g. a startup resume of an untrusted cwd before any client
      // connects) → deny-safe at once rather than hang the swap for 5 minutes.
      if (trustListeners.size === 0) {
        resolve(null);
        return;
      }
      const requestId = `trust-${now()}-${trustSeq++}`;
      const timer = setTimeout(
        () => settleTrust(requestId, null),
        TRUST_TIMEOUT_MS,
      );
      (timer as { unref?: () => void }).unref?.();
      pendingTrust.set(requestId, { resolve, timer });
      emitTrust({
        kind: "request",
        request: {
          requestId,
          cwd,
          title,
          options: options.map((o) => ({ label: o.label, trusted: o.trusted })),
        },
      });
    });

  // Every kept-warm session, keyed by sessionId. Created on first touch (startup
  // resume, newSession, or openSession); never disposed on a focus switch.
  const warm = new Map<SessionId, WarmSession>();
  // Fallback target when a command arrives without a sessionId (the hub normally
  // passes the focused id). Tracks the most-recently focused/created session.
  let currentId: SessionId | null = null;
  const warmCap = opts.warmCap ?? config.warmCap;

  // Mark a session as most-recently focused: set it current AND move it to the end of
  // the warm map, whose insertion order IS the recency order eviction reads.
  function focus(id: SessionId): void {
    currentId = id;
    const ws = warm.get(id);
    if (ws) {
      warm.delete(id);
      warm.set(id, ws);
    }
  }

  // Snapshot for one warm session at a given status. Reads the session live so
  // model/title/thinking changes show up whenever a snapshot is taken.
  const snapshotFor = (
    ws: WarmSession,
    status: SessionStatus,
  ): SessionSnapshot => {
    const m = ws.session.model;
    return {
      ref: ws.ref,
      workspace: {
        workspaceId: ws.cwd,
        path: ws.cwd,
        displayName: basename(ws.cwd),
      },
      title: ws.session.sessionName ?? "pi session",
      status,
      updatedAt: now(),
      config: {
        provider: m && typeof m.provider === "string" ? m.provider : undefined,
        modelId: m?.id,
        thinkingLevel: ws.session.thinkingLevel,
        availableThinkingLevels: ws.session.getAvailableThinkingLevels(),
      },
      usage: usageFor(ws),
      queuedMessages: queueMessages(
        ws.session.getSteeringMessages(),
        ws.session.getFollowUpMessages(),
        now(),
      ),
    };
  };

  // Context-window fill for a warm session, re-shaped to the wire type so nothing
  // pi-internal leaks. getContextUsage() walks the branch + estimates tokens over the
  // message list — O(messages), fine at turn boundaries / list refreshes, never on the
  // per-delta path. Undefined when the session has no model / no known window.
  const usageFor = (ws: WarmSession): SessionUsage | undefined => {
    const cu = ws.session.getContextUsage();
    return cu
      ? {
          tokens: cu.tokens,
          contextWindow: cu.contextWindow,
          percent: cu.percent,
        }
      : undefined;
  };

  // Emit a fresh snapshot for a warm session (after a model/thinking change). Status
  // tracks whether it's mid-stream so a change during a run doesn't read as idle.
  const emitUpdate = (ws: WarmSession): void =>
    emit({
      sessionRef: ws.ref,
      timestamp: now(),
      type: "sessionUpdated",
      snapshot: snapshotFor(ws, ws.session.isStreaming ? "running" : "idle"),
    });

  const toolMetaFor = (ws: WarmSession, name: string) => {
    const t = ws.session.getAllTools().find((x) => x.name === name);
    return { label: undefined, description: t?.description };
  };

  // The message-entries on the current branch, root→leaf, as {id, role, text} — the
  // raw material for correlating replayed messages back to their pi tree node (the id
  // lives on the entry wrapper, never on the message). Non-message entries (compaction,
  // branch_summary, model_change, …) are dropped: they don't appear in session.messages.
  const branchTextEntries = (ws: WarmSession) =>
    ws.session.sessionManager
      .getBranch()
      .filter(
        (e: SessionEntry): e is Extract<SessionEntry, { type: "message" }> =>
          e.type === "message",
      )
      .map((e) => ({
        id: e.id,
        role: (e.message as { role?: string }).role,
        text: contentToText(
          (e.message as { content?: unknown }).content as Parameters<
            typeof contentToText
          >[0],
        ),
      }));

  // Branch handles for the REPLAY seed: align each replayed message to its persisted
  // entry id (tail-anchored, compaction-safe — see branch-ids.ts). `messages` is the
  // SAME array seedFor feeds historyToEvents, so the returned ids line up by index.
  const replayEntryIds = (
    ws: WarmSession,
    messages: readonly HistoryMessage[],
  ): (string | undefined)[] =>
    correlateEntryIds(
      messages.map((m) => ({ role: m.role, text: contentToText(m.content) })),
      branchTextEntries(ws),
    );

  // Branch handles for a just-completed LIVE turn: the most recent user + assistant
  // entries on the branch (they've persisted by agent_end). The reducer stamps these
  // onto the turn-final assistant + this turn's user item via runCompleted.
  const turnEntryIdsFor = (
    ws: WarmSession,
  ): { userEntryId?: string; assistantEntryId?: string } => {
    let userEntryId: string | undefined;
    let assistantEntryId: string | undefined;
    for (const e of ws.session.sessionManager.getBranch()) {
      if (e.type !== "message") continue;
      const role = (e.message as { role?: string }).role;
      if (role === "user") userEntryId = e.id;
      else if (role === "assistant") assistantEntryId = e.id;
    }
    return { userEntryId, assistantEntryId };
  };

  // The seed for a warm session: a sessionOpened snapshot + its replayed history +
  // the bridge's retained ambient UI (status strip / widgets / title — pi can't
  // replay these, so the bridge does; otherwise a switch loses them, DECISIONS.md D5).
  // Emitted to the first subscriber for the startup session; returned (not emitted)
  // from openSession/newSession so the hub resets state and folds it atomically.
  const seedFor = (ws: WarmSession): SessionDriverEvent[] => {
    const messages = ws.session
      .messages as unknown as readonly HistoryMessage[];
    return [
      {
        sessionRef: ws.ref,
        timestamp: now(),
        type: "sessionOpened",
        snapshot: snapshotFor(ws, ws.session.isStreaming ? "running" : "idle"),
      },
      ...historyToEvents(
        messages,
        {
          ref: ws.ref,
          idleSnapshot: snapshotFor(ws, "idle"),
          toolMeta: (name) => toolMetaFor(ws, name),
        },
        replayEntryIds(ws, messages),
      ),
      ...ws.bridge.ambientSeedEvents(),
      // Dialogs are live bridge state, not persisted transcript history. Replay any
      // unresolved request after the history seed so refocusing a chat restores the
      // answer popup instead of leaving its extension blocked invisibly.
      ...ws.bridge.pendingRequests().map(
        (request): SessionDriverEvent => ({
          sessionRef: ws.ref,
          timestamp: now(),
          type: "hostUiRequest",
          request,
        }),
      ),
    ];
  };

  // Warm up a brand-new session from a SessionManager: create cwd-bound services (with
  // the per-cwd trust resolver), build the session, bind the UI bridge for approvals,
  // and subscribe its event stream into the shared emit. The cwd is taken from the
  // manager so an opened session is bound to ITS stored cwd, not the server's. Registers
  // and returns the WarmSession.
  async function warmUp(sessionManager: SessionManager): Promise<WarmSession> {
    const cwd = sessionManager.getCwd();
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      // Share the driver-wide auth store + model registry (see createPiDriver) so a key
      // saved via the Settings panel is visible to this session after a refresh. The
      // settings manager is left to default (cwd-bound, for correct project layering).
      authStorage,
      modelRegistry,
      // Without this, pi leaves projectTrusted=true and auto-loads every project's .pi
      // resources — the D12 gap. Resolve trust per cwd instead (non-interactive MVP;
      // honors trust.json, denies untrusted paths (no implicit trust — see createPiDriver).
      resourceLoaderReloadOptions: {
        resolveProjectTrust: makeTrustResolver(cwd, ask),
      },
    });
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager,
    });

    const ref: SessionRef = { workspaceId: cwd, sessionId: session.sessionId };
    const bridge = new PiUiBridge(ref, emit, now);
    const ws: WarmSession = {
      session,
      ref,
      cwd,
      bridge,
      unsubscribe: () => {},
    };

    // Extension UI calls (approvals + ambient) flow through this session's bridge;
    // binding is per-AgentSession and required for hostUiRequest to reach clients.
    // mode "rpc": pilot is a headless-but-dialog-capable host (a UI bridge, no
    // terminal) — pi's own semantics for that combination. Left unset it defaults to
    // "print" (hasUI=false territory), so pilot ran as the untested "print"+hasUI=true
    // combo and reported ctx.mode="print" to extensions. "rpc" lets terminal-only
    // extensions (e.g. a notify ext writing OSC escape codes) detect a non-tui host and
    // self-suppress, instead of firing a stray escape sequence into the server's stdout.
    await session.bindExtensions({
      uiContext: bridge as unknown as ExtensionUIContext,
      mode: "rpc",
      // pi catches throws from extension handlers, tags them with which
      // extension/event raised them, and routes them here. A terminal-only
      // capability use (the bridge's typed throw) becomes a compatibility
      // notice; anything else is a real extension error we surface rather than
      // swallow — without a listener pi would drop these silently.
      onError: (err) => {
        const issue = parseUnsupportedHostUiErrorMessage(err.error);
        if (issue) {
          emit({
            sessionRef: ref,
            timestamp: now(),
            type: "extensionCompatibilityIssue",
            issue: {
              ...issue,
              ...(err.extensionPath
                ? { extensionPath: err.extensionPath }
                : {}),
              ...(err.event ? { eventName: err.event } : {}),
            },
          });
          return;
        }
        bridge.notify(
          `[${err.extensionPath}] ${err.event}: ${err.error}`,
          "error",
        );
      },
    });
    ws.unsubscribe = session.subscribe((ev) => {
      for (const out of mapPiEvent(ev, {
        ref,
        now,
        toolMeta: (name) => toolMetaFor(ws, name),
        snapshot: (status) => snapshotFor(ws, status),
        // The live run status, for out-of-band events (e.g. a rename mid-turn) that
        // must NOT report idle — that would close the streaming bubble + clear the
        // running indicator. Turn-boundary events still hardcode running/idle.
        liveStatus: () => (ws.session.isStreaming ? "running" : "idle"),
        // Branch handles for the just-completed turn, read at agent_end (when the
        // messages have persisted) and stamped onto runCompleted so the live transcript
        // lights up its "branch from here" buttons without a reload.
        turnEntryIds: () => turnEntryIdsFor(ws),
      })) {
        emit(out);
      }
    });

    warm.set(session.sessionId, ws);
    // Enforce the warm cap: evict the least-recently-focused sessions (never the one
    // just created), disposing each — dispose() also aborts any in-flight run.
    for (const id of evictionPlan(
      [...warm.keys()],
      session.sessionId,
      warmCap,
    )) {
      const victim = warm.get(id);
      if (!victim) continue;
      // dispose() aborts any in-flight run but tears down pi's own event listeners, so
      // the abort's terminal event never reaches the hub. Emit a synthetic sessionClosed
      // FIRST (while the subscription is still live) so trackRunning clears this id from
      // the cross-session running set; otherwise an evicted mid-run session shows a
      // perpetual running indicator. Eviction happens inside a swap, so the hub only acts
      // on this for the running set — it's never folded into the focused transcript.
      emit({
        sessionRef: victim.ref,
        timestamp: now(),
        type: "sessionClosed",
        reason: "ended",
      });
      victim.unsubscribe();
      victim.session.dispose();
      warm.delete(id);
      console.log(`[pi] evicted LRU warm session ${id}; ${warm.size} warm`);
    }
    console.log(
      `[pi] warmed session ${session.sessionId} (${cwd}); ${warm.size} warm`,
    );
    return ws;
  }

  // Resolve the warm session a command targets: the explicit id, else the driver's
  // current focus. Returns null (caller drops) if neither resolves — loud, not silent.
  const target = (sessionId?: SessionId): WarmSession | null => {
    const id = sessionId ?? currentId;
    const ws = id ? warm.get(id) : undefined;
    if (!ws) {
      console.error(`[pi] no warm session for id=${id ?? "(none)"}`);
      return null;
    }
    return ws;
  };

  // Startup: boot to an empty landing (no warm session, focusedId=null). The client
  // opens a new-session draft at $HOME; a session is only materialized when the
  // operator sends a first prompt or opens one from the sidebar. (Restoring the
  // last-focused session on boot is a separate, planned fast-follow.)

  const toEntry = async (
    info: Awaited<ReturnType<typeof SessionManager.list>>[number],
  ): Promise<SessionListEntry> => ({
    sessionId: info.id,
    path: info.path,
    cwd: info.cwd,
    displayName: info.name,
    preview: info.firstMessage ?? "",
    // info.messageCount counts user + assistant + toolResult; the sidebar wants only
    // the operator's turns, so re-scan for role-"user" entries (cached by mtime+total).
    userMessageCount: await countUserMessages(
      info.path,
      info.modified.getTime(),
      info.messageCount,
    ),
    updatedAt: info.modified.toISOString(),
    createdAt: info.created.toISOString(),
    parentSessionPath: info.parentSessionPath,
    archived: archiveStore.has(info.path),
    worktree: (() => {
      const meta = worktreeStore.get(info.cwd);
      return meta
        ? { path: meta.path, base: meta.base, name: meta.name }
        : undefined;
    })(),
  });

  // A list entry for a warm session that isn't on disk yet. pi doesn't write a
  // session's .jsonl until its first ASSISTANT message — it buffers the header +
  // opening user turn in memory until then (SessionManager._persist). So a session
  // we just created + focused via newSession is invisible to listAll() and would be
  // missing from the very list we broadcast alongside its activeSessionId. Synthesize
  // a placeholder so the sidebar shows it the instant it's created; once it persists,
  // the richer disk entry supersedes it (deduped by sessionId in listSessions). cwd is
  // the only stable field; the timestamp is "now" so a brand-new session sorts to the
  // top and never reads as stale. preview = the first user message (firstUserPreview) so
  // an unnamed new session reads as its prompt, not "(untitled)", before pi names it.
  const warmEntry = (ws: WarmSession): SessionListEntry | null => {
    const path = ws.session.sessionFile;
    if (!path) return null; // non-persistent session (pilot never makes these)
    const nowIso = new Date().toISOString();
    const messages = ws.session
      .messages as unknown as readonly HistoryMessage[];
    return {
      sessionId: ws.ref.sessionId,
      path,
      cwd: ws.cwd,
      displayName: ws.session.sessionName,
      preview: firstUserPreview(messages),
      userMessageCount: messages.filter((m) => m.role === "user").length,
      // usage is attached uniformly by the post-merge overlay in listSessions (which
      // covers warm-only and disk-superseded entries alike), so it's omitted here.
      updatedAt: nowIso,
      createdAt: nowIso,
      archived: archiveStore.has(path),
    };
  };

  // Remove a pilot-created worktree at `cwd` and forget it. `force=false` leaves a dirty
  // worktree in place (returns removed:false). The index is the gate — we never touch a
  // worktree pilot didn't create.
  const reapWorktree = async (
    cwd: string,
    force: boolean,
  ): Promise<{ removed: boolean; reason?: string }> => {
    const meta = worktreeStore.get(cwd);
    if (!meta)
      return { removed: false, reason: "no pilot worktree at this path" };
    const res = await removeWorktree(meta, force);
    if (res.removed) worktreeStore.remove(cwd);
    return res;
  };

  return {
    subscribe(l) {
      listeners.add(l);
      // No boot session to seed: the server starts on an empty landing, and each
      // opened/created session delivers its own seed through switchTo. The first
      // subscriber (the hub) simply starts listening.
      return () => listeners.delete(l);
    },

    subscribeTrust(l) {
      trustListeners.add(l);
      return () => trustListeners.delete(l);
    },

    respondTrust(requestId, choice) {
      settleTrust(requestId, choice);
    },

    prompt(text, deliverAs, sessionId, images, promptId) {
      const ws = target(sessionId);
      if (!ws) return Promise.reject(new Error("No target session is open"));

      let preflightSettled = false;
      let preflightAccepted = false;
      const options: Record<string, unknown> = {};
      if (images && images.length > 0) options.images = images;
      if (ws.session.isStreaming && deliverAs)
        options.streamingBehavior = deliverAs;

      return new Promise<void>((resolve, reject) => {
        options.preflightResult = (accepted: boolean) => {
          if (preflightSettled) return;
          preflightSettled = true;
          if (!accepted) {
            reject(new Error("Prompt was rejected before acceptance"));
            return;
          }
          preflightAccepted = true;
          emit({
            sessionRef: ws.ref,
            timestamp: now(),
            type: "userMessage",
            id: promptId ?? `u-${now()}-${userSeq++}`,
            text,
            images,
          });
          resolve();
        };

        ws.session.prompt(text, options).catch((e) => {
          if (!preflightSettled) {
            preflightSettled = true;
            reject(e);
            return;
          }
          if (!preflightAccepted) return;
          // The prompt was accepted and ACKed; later model/tool failures belong in the
          // normal shared transcript rather than turning an accepted outbox item back
          // into a rejected submission.
          emit({
            sessionRef: ws.ref,
            timestamp: now(),
            type: "runFailed",
            error: { message: String(e) },
          });
        });
      });
    },

    abort(sessionId) {
      target(sessionId)
        ?.session.abort()
        .catch(() => {});
    },

    clearQueue(sessionId) {
      const ws = target(sessionId);
      return ws?.session.clearQueue() ?? { steering: [], followUp: [] };
    },

    respondUi(response: HostUiResponse, sessionId) {
      target(sessionId)?.bridge.resolve(response);
    },

    getUsage(sessionId) {
      // The same getContextUsage() snapshotFor reads, exposed standalone so the hub's
      // live ticker can refresh the meter mid-turn. O(messages) — only that ~1s tick
      // calls it, never the per-delta path.
      const cu = target(sessionId)?.session.getContextUsage();
      return cu
        ? {
            tokens: cu.tokens,
            contextWindow: cu.contextWindow,
            percent: cu.percent,
          }
        : undefined;
    },

    async listSessions() {
      // Every session on the machine, so the sidebar can group them by project dir
      // (the owner's choice — a cross-project navigator, not just the server cwd's sessions).
      const onDisk = await Promise.all(
        (await SessionManager.listAll()).map(toEntry),
      );
      // Surface warm sessions not yet persisted to disk (e.g. a just-created one) so the
      // sidebar shows them immediately; mergeSessionLists dedupes against the disk list.
      const warmEntries = [...warm.values()]
        .map(warmEntry)
        .filter((e): e is SessionListEntry => e !== null);
      const merged = mergeSessionLists(onDisk, warmEntries);
      // Overlay live context usage onto whichever entry won the merge (the disk entry
      // supersedes the warm placeholder, so usage set only on warmEntry would be lost).
      // Sessions not currently warm get no usage — we don't load them to compute it.
      const warmUsage = new Map<SessionId, SessionUsage>();
      for (const ws of warm.values()) {
        const u = usageFor(ws);
        if (u) warmUsage.set(ws.ref.sessionId, u);
      }
      return merged.map((e) => {
        const u = warmUsage.get(e.sessionId);
        return u ? { ...e, usage: u } : e;
      });
    },

    async setArchived(path: string, archived: boolean) {
      // Option B: the flag lives only in pilot's index, keyed by the .jsonl path. We do
      // NOT append to the session file — pi's list path drops custom entries, so that
      // copy would be write-only and force a per-session scan to read back.
      archiveStore.set(path, archived);
      // Archiving a worktree-backed session reaps the worktree when it's clean; a dirty
      // one is left in place (the sidebar keeps flagging it for manual cleanup). Resolve
      // the cwd from the .jsonl path via the same list the sidebar is built from.
      if (!archived) return;
      const info = (await SessionManager.listAll()).find(
        (s) => s.path === path,
      );
      if (info && worktreeStore.get(info.cwd))
        await reapWorktree(info.cwd, false).catch((e) =>
          console.error("[worktree] archive cleanup failed", e),
        );
    },

    async cleanupWorktree(path: string, opts?: { force?: boolean }) {
      return reapWorktree(path, opts?.force ?? false);
    },

    async renameSession(path: string, name: string) {
      const next = name.trim();
      if (!next) return;
      // A warm session owns an open AgentSession on this JSONL — rename through it so the
      // write goes through the single owning writer AND emits `session_info_changed`,
      // which re-snapshots the header title live (event-map.ts). Opening a second
      // SessionManager on the same file would race that writer.
      const warmSession = [...warm.values()].find(
        (w) => w.session.sessionFile === path,
      );
      if (warmSession) {
        warmSession.session.setSessionName(next);
        return;
      }
      // Cold session: append a `session_info` entry directly, exactly as pi's TUI rename
      // does. No live AgentSession, so the hub's list re-broadcast is what surfaces it.
      SessionManager.open(path).appendSessionInfo(next);
    },

    defaultSeed() {
      // Per-client focus: a freshly-connecting client adopts the driver's current
      // session if there is one. At boot there is none (empty landing) — the client
      // then restores its own last-focused session — so this returns null until a
      // session is opened/created. Read synchronously; seedFor is in-memory.
      const ws = currentId ? warm.get(currentId) : undefined;
      return ws ? seedFor(ws) : null;
    },

    async openSession(path: string) {
      // Already warm (matched by session file)? Just refocus — never open a second
      // AgentSession on the same JSONL; that would double-write the file. This is the
      // instant focus-switch for a backgrounded session, history and all.
      const existing = [...warm.values()].find(
        (w) => w.session.sessionFile === path,
      );
      if (existing)
        console.log(`[pi] refocus warm session ${existing.ref.sessionId}`);
      const ws = existing ?? (await warmUp(SessionManager.open(path)));
      focus(ws.ref.sessionId);
      return seedFor(ws);
    },

    async branchFrom(
      entryId: string,
      opts: { summarize?: boolean },
      sessionId?: SessionId,
    ) {
      const ws = target(sessionId);
      // Throw (not return empty) so the hub's switchTo keeps the current transcript on
      // failure rather than resetting to a blank state.
      if (!ws)
        throw new Error(
          `no warm session to branch (id=${sessionId ?? "(none)"})`,
        );
      const result = await ws.session.navigateTree(entryId, {
        summarize: opts.summarize ?? false,
      });
      // Re-seed from the now-current branch. On a no-op/cancel the branch is unchanged,
      // so the seed equals the current transcript — the re-seed is harmless either way,
      // and never blanks state. NOTE: a no-summary jump only moves the in-memory leaf;
      // it isn't durable until the next prompt appends a child (a cold reopen before
      // then re-derives the leaf to the file tail). Fine for the warm jump-then-prompt
      // flow; see docs/TODO.md for the durability follow-up.
      return {
        seed: seedFor(ws),
        editorText: result.editorText,
        cancelled: result.cancelled,
        aborted: result.aborted,
      };
    },

    async getTree(sessionId?: SessionId) {
      const ws = target(sessionId);
      if (!ws) return undefined;
      // The full branch tree lives in the SessionManager already (every entry +
      // parentId), so this is a pure read — no new pi capability, just a projection
      // alongside branchTextEntries. Unlike those, it reads getTree() (the whole DAG),
      // not getBranch() (only the active path), so abandoned branches are visible.
      return projectTree(ws.session.sessionManager);
    },

    async newSession(opts: NewSessionOpts = {}) {
      const { cwd, worktree, model, thinking } = opts;
      // D12: the GUI may open any path. Expand a leading `~/` (or bare `~`), make it
      // absolute, and fail loudly if it isn't a real directory rather than letting pi
      // create a session against a typo'd cwd. An untrusted new cwd still works — trust
      // only gates that repo's .pi resources (resolved per-cwd in warmUp), not the
      // session. `~otheruser` is left literal (we can't resolve another user's home);
      // it falls through to the statSync guard and fails loudly like any bad path.
      let dir = homedir();
      if (cwd?.trim()) {
        dir = resolveGuiPath(cwd);
        let stat: ReturnType<typeof statSync> | undefined;
        try {
          stat = statSync(dir);
        } catch {
          throw new Error(`no such directory: ${dir}`);
        }
        if (!stat.isDirectory()) throw new Error(`not a directory: ${dir}`);
      }
      // Worktree toggle: isolate the session in a fresh jj/git worktree of `dir` so the
      // agent works on a clean copy. Throws loudly if `dir` isn't a repo (surfaced to UI).
      // Record it (keyed by the worktree dir, which becomes the session cwd) so the
      // sidebar can flag it and it can be cleaned up later.
      if (worktree) {
        const meta = await createWorktree(dir);
        worktreeStore.add(meta);
        dir = meta.path;
      }
      const ws = await warmUp(SessionManager.create(dir));
      // Apply the draft's model/thinking BEFORE seedFor so the returned seed snapshot
      // already reflects them (the hub folds the seed atomically; subscribe-side
      // sessionUpdated emissions are dropped while switching). setThinkingLevel clamps
      // to what the chosen model supports, so an unsupported draft level is graceful.
      if (model) {
        const m = ws.session.modelRegistry.find(model.provider, model.modelId);
        if (m) await ws.session.setModel(m);
        else
          console.error(
            `[pi] newSession: unknown model ${model.provider}:${model.modelId}`,
          );
      }
      if (thinking)
        ws.session.setThinkingLevel(
          thinking as Parameters<typeof ws.session.setThinkingLevel>[0],
        );
      focus(ws.ref.sessionId);
      return seedFor(ws);
    },

    async listModels() {
      // The shared registry (createPiDriver) is the same view every warm session sees.
      // getAvailable() = models with working credentials, i.e. the ones actually
      // switchable — and it reflects any key just saved via the Settings panel.
      modelRegistry.refresh();
      return modelRegistry.getAvailable().map((m) => ({
        provider: String(m.provider),
        modelId: m.id,
        label: m.name,
        thinkingLevels: supportedThinkingLevels(m),
      }));
    },

    async listFileIndex(sessionId) {
      const ws = target(sessionId);
      if (!ws) return { files: [], truncated: false };
      return listFileIndexWithFd(ws.cwd);
    },

    async listFiles(query, sessionId, cwd) {
      // A new-session draft passes its target project dir directly (no session exists yet);
      // otherwise resolve the cwd from the focused session. `fd` is read-only + .gitignore-
      // aware, and the cwd is one the single user picked, so searching it is safe.
      if (cwd) return listFilesWithFd(cwd, query);
      const ws = target(sessionId);
      if (!ws) return [];
      return listFilesWithFd(ws.cwd, query);
    },

    async listDir(path) {
      // Empty/blank -> $HOME (the new-session default cwd). Otherwise expand + resolve on
      // the server's filesystem — the picker browses the server, not the client device.
      const dir = path?.trim() ? resolveGuiPath(path) : homedir();
      return listDirOnDisk(dir);
    },

    async listCommands(sessionId) {
      // The three user-defined command sources pi's own RPC `get_commands` returns; the
      // TUI builtins (/model, /settings, …) are intentionally omitted — pilot has native
      // UI for those. Read from the targeted session because each is cwd-scoped (its
      // extensions/templates/skills come from that workspace's `.pi`). Sending one is a
      // plain prompt: pi's prompt() runs extension commands and expands templates/skills.
      const ws = target(sessionId);
      if (!ws) return [];
      const out: CommandInfo[] = [];
      for (const c of ws.session.extensionRunner.getRegisteredCommands())
        out.push({
          name: c.invocationName,
          description: c.description,
          source: "extension",
        });
      for (const t of ws.session.promptTemplates)
        out.push({
          name: t.name,
          description: t.description,
          source: "prompt",
          argumentHint: t.argumentHint,
        });
      for (const s of ws.session.resourceLoader.getSkills().skills)
        out.push({
          name: `skill:${s.name}`,
          description: s.description,
          source: "skill",
        });
      return out;
    },

    setModel(provider, modelId, sessionId) {
      const ws = target(sessionId);
      if (!ws) return;
      const model = ws.session.modelRegistry.find(provider, modelId);
      if (!model) {
        console.error(`[pi] setModel: unknown model ${provider}:${modelId}`);
        return;
      }
      ws.session
        .setModel(model)
        .then(() => emitUpdate(ws))
        .catch((e) => console.error("[pi] setModel failed", e));
    },

    setThinking(level, sessionId) {
      const ws = target(sessionId);
      if (!ws) return;
      // setThinkingLevel wants pi's ThinkingLevel union; the wire carries a string.
      ws.session.setThinkingLevel(
        level as Parameters<typeof ws.session.setThinkingLevel>[0],
      );
      emitUpdate(ws);
    },

    // --- Global provider/model config (Settings panel) ---

    async listProviders() {
      modelRegistry.refresh();
      // Provider id -> display name for the OAuth-capable set (Anthropic, OpenAI Codex,
      // GitHub Copilot). Carries pi's nicer label ("Anthropic (Claude Pro/Max)") and is
      // what lets an UNAUTHED OAuth provider still show a row (so its "Sign in" button
      // has a home) even though it isn't in the curated key-capable set.
      const oauthProviders = new Map(
        authStorage.getOAuthProviders().map((p) => [p.id, p.name]),
      );
      // Every provider pi knows a model for, plus every OAuth-capable and every
      // already-authed one — then narrowed (Q2) to the curated key-capable set, the
      // OAuth-capable set, and the already-connected, so the phone panel isn't a wall of
      // irrelevant rows.
      const ids = new Set<string>([
        ...modelRegistry.getAll().map((m) => String(m.provider)),
        ...oauthProviders.keys(),
        ...authStorage.list(),
      ]);
      const out: ProviderInfo[] = [];
      for (const id of [...ids].sort((a, b) => a.localeCompare(b))) {
        const keySetup = apiKeySetupSupported(id);
        const oauthSupported = oauthProviders.has(id);
        const status = modelRegistry.getProviderAuthStatus(id);
        const hasAuth = status.configured || authStorage.hasAuth(id);
        if (!keySetup && !oauthSupported && !hasAuth) continue;
        out.push({
          id,
          name:
            modelRegistry.getProviderDisplayName(id) ||
            oauthProviders.get(id) ||
            id,
          hasAuth,
          authSource: inferAuthSource(
            authStorage.get(id) as AuthCred | undefined,
            status,
            keySetup,
          ),
          apiKeySetupSupported: keySetup,
          oauthSupported,
        });
      }
      return out;
    },

    async setProviderApiKey(providerId, apiKey) {
      const key = apiKey.trim();
      if (!key) throw new Error("API key is required");
      if (!apiKeySetupSupported(providerId))
        throw new Error(`API key setup isn't supported for ${providerId}`);
      authStorage.set(providerId, { type: "api_key", key });
      modelRegistry.refresh(); // newly-authed provider's models become available
    },

    async removeProviderApiKey(providerId) {
      authStorage.remove(providerId);
      modelRegistry.refresh();
    },

    async oauthLogin(providerId: string, io: OAuthLoginIO) {
      // Map pi's OAuth callbacks onto the hub's IO. The flow is built for the remote
      // case: pi opens an authorize URL (onAuth), starts a localhost loopback that the
      // phone can't reach, and — because we provide onManualCodeInput — races that
      // loopback against the operator pasting the code/redirect-URL back. authStorage
      // persists the tokens + auto-refreshes them on use; we only bridge the prompts.
      let authUrl: string | undefined;
      let authInstructions: string | undefined;
      // A cancelled prompt (io.prompt -> null) must abort, not silently retry with "".
      const required = (answer: string | null): string => {
        if (answer == null) throw new Error("OAuth login cancelled");
        return answer;
      };
      await authStorage.login(providerId, {
        onAuth: (info) => {
          authUrl = info.url;
          authInstructions = info.instructions;
          // Surface the link immediately too, so it's visible even for a loopback-only
          // provider that never calls onManualCodeInput/onPrompt to carry it.
          io.progress(`Open this URL to authorize:\n${info.url}`);
        },
        onManualCodeInput: () =>
          io
            .prompt({
              kind: "input",
              message: "Paste the authorization code or the full redirect URL",
              placeholder: "code, or http://localhost/callback?code=…",
              url: authUrl,
              instructions: authInstructions,
            })
            .then(required),
        onPrompt: (p) =>
          io
            .prompt({
              kind: "input",
              message: p.message,
              placeholder: p.placeholder,
              url: authUrl,
              instructions: authInstructions,
            })
            .then((answer) =>
              answer == null ? (p.allowEmpty ? "" : required(answer)) : answer,
            ),
        onSelect: (p) =>
          io
            .prompt({
              kind: "select",
              message: p.message,
              options: p.options.map((o) => ({ id: o.id, label: o.label })),
            })
            .then((answer) => answer ?? undefined),
        onProgress: (m) => io.progress(m),
        onDeviceCode: (info) =>
          io.deviceCode({
            userCode: info.userCode,
            verificationUri: info.verificationUri,
            expiresInSeconds: info.expiresInSeconds,
          }),
      });
      modelRegistry.refresh(); // the newly-authed provider's models become available
    },

    async oauthLogout(providerId: string) {
      authStorage.logout(providerId);
      modelRegistry.refresh();
    },

    async getModelDefaults(): Promise<ModelDefaults> {
      return {
        provider: globalSettings.getDefaultProvider(),
        modelId: globalSettings.getDefaultModel(),
        thinkingLevel: globalSettings.getDefaultThinkingLevel(),
        favorites: resolveFavorites(
          globalSettings.getEnabledModels(),
          availableModelLikes(),
        ),
      };
    },

    async setDefaultModel(provider, modelId) {
      globalSettings.setDefaultModelAndProvider(provider, modelId);
      await globalSettings.flush();
    },

    async setDefaultThinking(level) {
      globalSettings.setDefaultThinkingLevel(
        level as Parameters<typeof globalSettings.setDefaultThinkingLevel>[0],
      );
      await globalSettings.flush();
    },

    async setFavoriteModels(refs) {
      // Preserve patterns the GUI can't represent (CLI globs, offline-provider
      // favorites); replace the available-resolvable ones with the explicit selection.
      const patterns = mergeFavoritePatterns(
        globalSettings.getEnabledModels(),
        refs,
        availableModelLikes(),
      );
      globalSettings.setEnabledModels(patterns);
      await globalSettings.flush();
    },
  };
}
