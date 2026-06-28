import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  coldSessionEntry,
  defaultSessionsDir,
  listColdSessions,
  listSessionIds,
  readSessionJson,
  type SessionJson,
} from "./sessions-registry.js";

/** Make a temp sessions dir and populate it with the given session metadatas. */
function makeSessionsDir(
  sessions: Record<string, SessionJson | null>,
): string {
  const dir = mkdtempSync(join(tmpdir(), "pt-sessions-"));
  for (const [id, meta] of Object.entries(sessions)) {
    const sessionDir = join(dir, id);
    mkdirSync(sessionDir, { recursive: true });
    if (meta) writeFileSync(join(sessionDir, "session.json"), JSON.stringify(meta));
    // A failed startup has no session.json — leave the dir empty to simulate.
  }
  return dir;
}

const baseMeta = (over: Partial<SessionJson> = {}): SessionJson => ({
  session_id: "test",
  project_path: "/proj",
  created_at: "2026-06-28T10:00:00Z",
  last_activity_at: "2026-06-28T11:00:00Z",
  last_user_message_preview: "hello",
  initial_model_name: "anthropic/claude",
  parent_session_id: { kind: "standalone" },
  ...over,
});

describe("sessions-registry", () => {
  test("defaultSessionsDir respects XDG_DATA_HOME", () => {
    const orig = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = "/custom/xdg";
    expect(defaultSessionsDir()).toBe("/custom/xdg/polytoken/sessions");
    process.env.XDG_DATA_HOME = orig;
  });

  test("defaultSessionsDir falls back to ~/.local/share when XDG unset", () => {
    const orig = process.env.XDG_DATA_HOME;
    delete process.env.XDG_DATA_HOME;
    const dir = defaultSessionsDir();
    expect(dir).toContain("polytoken/sessions");
    expect(dir).toContain(".local/share");
    process.env.XDG_DATA_HOME = orig;
  });

  test("readSessionJson returns null for a dir with no session.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "pt-empty-"));
    expect(readSessionJson(dir)).toBeNull();
  });

  test("readSessionJson returns null for a corrupt file (no throw)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pt-corrupt-"));
    writeFileSync(join(dir, "session.json"), "{not valid json");
    expect(readSessionJson(dir)).toBeNull();
  });

  test("readSessionJson parses a valid file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pt-valid-"));
    writeFileSync(join(dir, "session.json"), JSON.stringify(baseMeta()));
    expect(readSessionJson(dir)).toEqual(baseMeta());
  });

  test("listSessionIds returns session dirs sorted newest-first", () => {
    const dir = makeSessionsDir({
      "older": baseMeta({ session_id: "older" }),
      "newer": baseMeta({ session_id: "newer" }),
    });
    const ids = listSessionIds(dir);
    expect(ids).toHaveLength(2);
    // "newer" was created after "older" (later mtime), so it sorts first.
    expect(ids[0]).toBe("newer");
  });

  test("listSessionIds skips non-directory entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "pt-mixed-"));
    mkdirSync(join(dir, "real-session"));
    writeFileSync(join(dir, "stray-file.json"), "{}");
    expect(listSessionIds(dir)).toEqual(["real-session"]);
  });

  test("listSessionIds returns [] for a missing dir", () => {
    expect(listSessionIds("/nonexistent/path/xyz")).toEqual([]);
  });

  test("coldSessionEntry builds a SessionListEntry from session.json", () => {
    const dir = makeSessionsDir({
      "abc123": baseMeta({
        session_id: "abc123",
        project_path: "/my/proj",
        last_user_message_preview: "do the thing",
      }),
    });
    const entry = coldSessionEntry(join(dir, "abc123"), "abc123", {
      archived: false,
    });
    expect(entry).not.toBeNull();
    expect(entry).toMatchObject({
      sessionId: "abc123",
      cwd: "/my/proj",
      preview: "do the thing",
      archived: false,
      lastUserMessageAt: "2026-06-28T11:00:00Z",
    });
    expect(entry!.path).toBe(join(dir, "abc123", "session.json"));
  });

  test("coldSessionEntry returns null for a failed startup (no session.json)", () => {
    const dir = makeSessionsDir({ "failed": null });
    expect(coldSessionEntry(join(dir, "failed"), "failed", { archived: false })).toBeNull();
  });

  test("coldSessionEntry: lastUserMessageAt falls back to createdAt when no preview", () => {
    const dir = makeSessionsDir({
      "no-turn": baseMeta({
        session_id: "no-turn",
        last_user_message_preview: undefined,
        last_activity_at: "2026-06-28T11:00:00Z",
        created_at: "2026-06-28T10:00:00Z",
      }),
    });
    const entry = coldSessionEntry(join(dir, "no-turn"), "no-turn", {
      archived: false,
    });
    // No preview → last activity wasn't a user turn → fall back to createdAt.
    expect(entry!.lastUserMessageAt).toBe("2026-06-28T10:00:00Z");
    expect(entry!.preview).toBe("");
  });

  test("coldSessionEntry: local parent → parentSessionPath set", () => {
    const dir = makeSessionsDir({
      "child": baseMeta({
        session_id: "child",
        parent_session_id: { kind: "local", session_id: "parent-id" },
      }),
    });
    const entry = coldSessionEntry(join(dir, "child"), "child", {
      archived: false,
    });
    expect(entry!.parentSessionPath).toBe("parent-id");
  });

  test("coldSessionEntry: standalone parent → no parentSessionPath", () => {
    const dir = makeSessionsDir({
      "solo": baseMeta({ session_id: "solo", parent_session_id: { kind: "standalone" } }),
    });
    const entry = coldSessionEntry(join(dir, "solo"), "solo", {
      archived: false,
    });
    expect(entry!.parentSessionPath).toBeUndefined();
  });

  test("listColdSessions merges archive + worktree flags", () => {
    const dir = makeSessionsDir({
      "s1": baseMeta({ session_id: "s1", project_path: "/p1" }),
      "s2": baseMeta({ session_id: "s2", project_path: "/p2" }),
      "failed": null,
    });
    const archivedPaths = new Set([join(dir, "s2", "session.json")]);
    const entries = listColdSessions(dir, {
      archivedFor: (p) => archivedPaths.has(p),
      worktreeFor: (cwd) =>
        cwd === "/p1" ? { path: "/p1", base: "/repo", name: "wt-name" } : undefined,
    });
    expect(entries).toHaveLength(2); // "failed" skipped
    const s1 = entries.find((e) => e.sessionId === "s1")!;
    const s2 = entries.find((e) => e.sessionId === "s2")!;
    expect(s1.archived).toBe(false);
    expect(s1.worktree).toEqual({ path: "/p1", base: "/repo", name: "wt-name" });
    expect(s2.archived).toBe(true);
    expect(s2.worktree).toBeUndefined();
  });

  test("listColdSessions returns [] for a missing dir", () => {
    expect(
      listColdSessions("/nonexistent", {
        archivedFor: () => false,
      }),
    ).toEqual([]);
  });
});
