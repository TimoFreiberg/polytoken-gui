import { describe, expect, test } from "bun:test";
import type { SessionListEntry } from "@pilot/protocol";
import { STALE_MS, filterSessions, isStale } from "./session-filter.js";

const NOW = 1_700_000_000_000;
const isoAgo = (ms: number) => new Date(NOW - ms).toISOString();

function entry(over: Partial<SessionListEntry> = {}): SessionListEntry {
  return {
    sessionId: "s",
    path: "/s.jsonl",
    cwd: "/proj",
    preview: "",
    userMessageCount: 1,
    updatedAt: isoAgo(0),
    createdAt: isoAgo(0),
    archived: false,
    ...over,
  };
}

const active = { query: "", showArchived: false, now: NOW };

describe("isStale", () => {
  test("recent → not stale, week-old → stale", () => {
    expect(isStale(entry({ updatedAt: isoAgo(60_000) }), NOW)).toBe(false);
    expect(isStale(entry({ updatedAt: isoAgo(STALE_MS + 1000) }), NOW)).toBe(
      true,
    );
  });
  test("an unparseable timestamp is never stale", () => {
    expect(isStale(entry({ updatedAt: "not-a-date" }), NOW)).toBe(false);
  });
});

describe("filterSessions", () => {
  test("groups by cwd, sorts items + groups newest-first", () => {
    const { groups } = filterSessions(
      [
        entry({ path: "/a", cwd: "/proj1", updatedAt: isoAgo(3000) }),
        entry({ path: "/b", cwd: "/proj1", updatedAt: isoAgo(1000) }),
        entry({ path: "/c", cwd: "/proj2", updatedAt: isoAgo(2000) }),
      ],
      active,
    );
    expect(groups.map((g) => g.cwd)).toEqual(["/proj1", "/proj2"]); // proj1 newest item is newest overall
    expect(groups[0].items.map((i) => i.path)).toEqual(["/b", "/a"]); // newest first
  });

  test("active-only hides archived and stale; show-all reveals them", () => {
    const sessions = [
      entry({ path: "/live", cwd: "/p" }),
      entry({ path: "/arch", cwd: "/p", archived: true }),
      entry({ path: "/old", cwd: "/p", updatedAt: isoAgo(STALE_MS + 1000) }),
    ];
    const activeOnly = filterSessions(sessions, active);
    expect(activeOnly.groups[0].items.map((i) => i.path)).toEqual(["/live"]);
    expect(activeOnly.hiddenCount).toBe(2);

    const all = filterSessions(sessions, { ...active, showArchived: true });
    expect(all.groups[0].items.map((i) => i.path).sort()).toEqual([
      "/arch",
      "/live",
      "/old",
    ]);
    expect(all.hiddenCount).toBe(0);
  });

  test("a group whose sessions are all hidden disappears from the active view", () => {
    const sessions = [
      entry({ path: "/live", cwd: "/active-proj" }),
      entry({ path: "/x", cwd: "/dormant", updatedAt: isoAgo(STALE_MS + 1) }),
      entry({ path: "/y", cwd: "/dormant", archived: true }),
    ];
    const { groups } = filterSessions(sessions, active);
    expect(groups.map((g) => g.cwd)).toEqual(["/active-proj"]);
  });

  test("search matches name, preview, and path; query is independent of hiddenCount", () => {
    const sessions = [
      entry({ path: "/a", displayName: "Fold reducer" }),
      entry({ path: "/b", preview: "scratch notes", cwd: "/other" }),
      entry({ path: "/c", cwd: "/deep/scratch" }),
      entry({ path: "/d", archived: true, displayName: "Fold archived" }),
    ];
    const byName = filterSessions(sessions, { ...active, query: "fold" });
    expect(byName.groups.flatMap((g) => g.items.map((i) => i.path))).toEqual([
      "/a",
    ]); // archived "/d" still hidden by active-only
    // hiddenCount reflects archived/stale regardless of the search query
    expect(byName.hiddenCount).toBe(1);

    const byPath = filterSessions(sessions, { ...active, query: "scratch" });
    expect(
      byPath.groups.flatMap((g) => g.items.map((i) => i.path)).sort(),
    ).toEqual(["/b", "/c"]);
  });
});
