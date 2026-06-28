// Reading polytoken's on-disk sessions registry WITHOUT spawning a daemon.
//
// polytoken writes one directory per session under the sessions dir (default
// `$XDG_DATA_HOME/polytoken/sessions` or `~/.local/share/polytoken/sessions`),
// each holding `session.json` (the durable metadata), `log.jsonl` (the event
// log), and `startup.json` (the last daemon-start state: ready/failed + pid/port).
//
// `polytoken sessions` only lists LIVE daemons (with a pid/port) and stale-cleans
// dead entries — it is NOT a source for the session sidebar. The sidebar wants
// every session that has ever existed, cold or warm, so the on-disk `session.json`
// registry is the authoritative list. This module reads it directly: no daemon
// spawn needed until a session is opened.
//
// A failed daemon startup leaves a session dir with `startup.json{state:"failed"}`
// but NO `session.json` — those dirs have no metadata to list from, so they are
// skipped (surfacing a "failed" stub with no title/cwd would be noise in the
// sidebar; the live `polytoken sessions` command already stale-cleans them).

import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionListEntry } from "@pilot/protocol";

/** The on-disk `session.json` shape — the durable per-session metadata polytoken
 *  writes when a session is created. Fields are all optional in the parser because
 *  a corrupt or partial file must degrade to "unknown" rather than crash the list. */
export interface SessionJson {
  session_id: string;
  project_path: string;
  created_at: string;
  last_activity_at: string;
  /** The first ~N chars of the first user message. Absent on a session with no turn. */
  last_user_message_preview?: string;
  initial_model_name?: string;
  /** Tagged: {kind:"standalone"} | {kind:"local", session_id}. The parent session,
   *  for subsessions. Standalone = no parent. */
  parent_session_id?: { kind: string; session_id?: string };
}

/** Resolve the default sessions dir the daemon uses, mirroring polytoken's own
 *  resolution: `$XDG_DATA_HOME/polytoken/sessions` or `~/.local/share/polytoken/sessions`.
 *  The daemon's `--sessions-dir` flag overrides this; callers that spawn a daemon
 *  with a custom dir should pass the same dir here so the list matches. */
export function defaultSessionsDir(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  const base = xdg || join(homedir(), ".local", "share");
  return join(base, "polytoken", "sessions");
}

/** Read one session dir's `session.json`, or null if it has none (a failed startup
 *  leaves a dir with only `startup.json`). Loud-fails a corrupt file to a console
 *  warning + null so one bad session can't blank the whole sidebar. */
export function readSessionJson(
  sessionDir: string,
): SessionJson | null {
  const file = join(sessionDir, "session.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as SessionJson;
  } catch (e) {
    console.error(`[polytoken] failed to parse ${file}`, e);
    return null;
  }
}

/** The list of session ids on disk (one per subdirectory of the sessions dir that
 *  has a `session.json`). Sorted newest-first by directory mtime — the sidebar
 *  re-sorts anyway, but this keeps the raw order sensible. */
export function listSessionIds(sessionsDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(sessionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  // Sort by mtime desc (newest first). A missing/unreadable mtime sorts last.
  const withMtime = entries.map((name) => {
    try {
      return { name, mtime: statSync(join(sessionsDir, name)).mtimeMs };
    } catch {
      return { name, mtime: -Infinity };
    }
  });
  withMtime.sort((a, b) => b.mtime - a.mtime);
  return withMtime.map((e) => e.name);
}

/** Build a `SessionListEntry` for a COLD session (no daemon spawned) from its
 *  on-disk `session.json`. `path` is the `session.json` file path — the stable
 *  switch key the client sends to `openSession` (mirrors pi's .jsonl-path key).
 *  `archived` + `worktree` are resolved by the caller (pilot-side stores) since
 *  they're pilot's own flags, not polytoken's. Returns null when the session has
 *  no readable `session.json` (a failed startup) — those dirs are skipped. */
export function coldSessionEntry(
  sessionDir: string,
  sessionId: string,
  opts: {
    archived: boolean;
    worktree?: SessionListEntry["worktree"];
  },
): SessionListEntry | null {
  const meta = readSessionJson(sessionDir);
  if (!meta) return null;
  const createdAt = meta.created_at ?? new Date(0).toISOString();
  const updatedAt = meta.last_activity_at ?? createdAt;
  // last_user_message_preview doubles as the sidebar preview AND the "last user
  // message at" proxy — when present, last activity was a user turn (preview is
  // captured on user-message). When absent (no turns yet), fall back to createdAt.
  const preview = meta.last_user_message_preview ?? "";
  const lastUserMessageAt = preview ? updatedAt : createdAt;
  const parentSessionPath =
    meta.parent_session_id?.kind === "local" &&
    meta.parent_session_id.session_id
      ? meta.parent_session_id.session_id
      : undefined;
  return {
    sessionId,
    path: join(sessionDir, "session.json"),
    cwd: meta.project_path ?? sessionDir,
    displayName: undefined,
    preview,
    // The daemon doesn't expose a per-session user-message count without a daemon;
    // 0 is a safe default (the sidebar shows it, not a wrong number).
    userMessageCount: 0,
    updatedAt,
    createdAt,
    lastUserMessageAt,
    parentSessionPath,
    archived: opts.archived,
    ...(opts.worktree ? { worktree: opts.worktree } : {}),
  };
}

/** List every cold session on disk as `SessionListEntry`s. Sessions with no
 *  `session.json` (failed startups) are skipped. The `worktreeFor`/`archivedFor`
 *  callbacks resolve pilot's own side-flags keyed by the session path. */
export function listColdSessions(
  sessionsDir: string,
  opts: {
    archivedFor: (sessionPath: string) => boolean;
    worktreeFor?: (cwd: string) => SessionListEntry["worktree"] | undefined;
  },
): SessionListEntry[] {
  const out: SessionListEntry[] = [];
  for (const id of listSessionIds(sessionsDir)) {
    const sessionDir = join(sessionsDir, id);
    // Resolve worktree from the session's cwd (the worktree dir == session cwd).
    // Read the json first to get cwd, then resolve the worktree flag, then build
    // the entry with both resolved — coldSessionEntry takes the resolved flags.
    const meta = readSessionJson(sessionDir);
    if (!meta) continue;
    const cwd = meta.project_path ?? sessionDir;
    const worktree = opts.worktreeFor ? opts.worktreeFor(cwd) : undefined;
    const entry = coldSessionEntry(sessionDir, id, {
      archived: opts.archivedFor(join(sessionDir, "session.json")),
      worktree,
    });
    if (!entry) continue;
    out.push(entry);
  }
  return out;
}
