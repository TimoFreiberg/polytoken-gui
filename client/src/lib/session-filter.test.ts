import { describe, expect, test } from "bun:test";
import type { SessionListEntry } from "@pantoken/protocol";
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
    lastUserMessageAt: isoAgo(0),
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
  test("groups projects alphabetically by name; items stay most-recently-used first", () => {
    const { groups } = filterSessions(
      [
        // /zebra holds the newest item overall, /apple older ones — alphabetical group
        // order must still put apple first, proving groups don't sort by recency.
        entry({ path: "/z1", cwd: "/zebra", lastUserMessageAt: isoAgo(1000) }),
        entry({ path: "/a1", cwd: "/apple", lastUserMessageAt: isoAgo(3000) }),
        entry({ path: "/a2", cwd: "/apple", lastUserMessageAt: isoAgo(2000) }),
      ],
      active,
    );
    expect(groups.map((g) => g.cwd)).toEqual(["/apple", "/zebra"]); // A→Z by basename
    expect(groups[0].items.map((i) => i.path)).toEqual(["/a2", "/a1"]); // newest interaction first
  });

  test("sorts by last user-message time, not by agent activity (updatedAt)", () => {
    const { groups } = filterSessions(
      [
        // /streaming is mid-run: its updatedAt is the freshest of all (the agent just
        // emitted a token), but the operator last prompted it a while ago. /idle was
        // prompted more recently. Recency-of-interaction must put /idle on top — proving
        // a streaming session can't leapfrog by bumping updatedAt.
        entry({
          path: "/streaming",
          updatedAt: isoAgo(1),
          lastUserMessageAt: isoAgo(10 * 60_000),
        }),
        entry({
          path: "/idle",
          updatedAt: isoAgo(60_000),
          lastUserMessageAt: isoAgo(60_000),
        }),
      ],
      active,
    );
    expect(groups[0].items.map((i) => i.path)).toEqual(["/idle", "/streaming"]);
  });

  test("falls back to updatedAt when lastUserMessageAt is absent", () => {
    const { groups } = filterSessions(
      [
        entry({
          path: "/older",
          updatedAt: isoAgo(3000),
          lastUserMessageAt: "",
        }),
        entry({
          path: "/newer",
          updatedAt: isoAgo(1000),
          lastUserMessageAt: "",
        }),
      ],
      active,
    );
    expect(groups[0].items.map((i) => i.path)).toEqual(["/newer", "/older"]);
  });

  test("project sort uses the cwd basename, case-insensitively", () => {
    const { groups } = filterSessions(
      [
        entry({ path: "/1", cwd: "/Users/me/Zoo" }),
        entry({ path: "/2", cwd: "/srv/apps/alpha" }),
        entry({ path: "/3", cwd: "/home/beta" }),
      ],
      active,
    );
    // basenames Zoo / alpha / beta sort case-insensitively to alpha, beta, Zoo
    expect(groups.map((g) => g.cwd)).toEqual([
      "/srv/apps/alpha",
      "/home/beta",
      "/Users/me/Zoo",
    ]);
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

  test("pinnedIds keeps archived/stale sessions visible and out of hiddenCount", () => {
    const sessions = [
      entry({ sessionId: "live", path: "/live", cwd: "/p" }),
      entry({ sessionId: "arch", path: "/arch", cwd: "/p", archived: true }),
      entry({
        sessionId: "old",
        path: "/old",
        cwd: "/p",
        updatedAt: isoAgo(STALE_MS + 1000),
      }),
    ];
    // Pin the archived one (e.g. it's running or focused) — it shows, and no longer
    // counts as hidden; the stale one stays hidden.
    const pinned = filterSessions(sessions, {
      ...active,
      pinnedIds: new Set(["arch"]),
    });
    expect(pinned.groups[0].items.map((i) => i.path).sort()).toEqual([
      "/arch",
      "/live",
    ]);
    expect(pinned.hiddenCount).toBe(1);
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

  test("a pantoken-created worktree session groups under its parent project (base), not its own cwd", () => {
    const sessions = [
      entry({
        path: "/wt",
        cwd: "/proj-pantoken-abc",
        lastUserMessageAt: isoAgo(1000),
        worktree: { path: "/proj-pantoken-abc", base: "/proj", name: "pantoken-abc" },
      }),
      entry({ path: "/main", cwd: "/proj", lastUserMessageAt: isoAgo(3000) }),
    ];
    const { groups } = filterSessions(sessions, active);
    // One group keyed by the parent project, not two — and no group labelled
    // "proj-pantoken-abc".
    expect(groups.map((g) => g.cwd)).toEqual(["/proj"]);
    // Interleaved most-recently-used first: the worktree session (newer) above the main one.
    expect(groups[0].items.map((i) => i.path)).toEqual(["/wt", "/main"]);
  });

  test("a worktree session whose parent base has no other sessions still forms a group labelled by the parent", () => {
    const sessions = [
      entry({
        path: "/wt",
        cwd: "/proj-pantoken-abc",
        worktree: { path: "/proj-pantoken-abc", base: "/proj", name: "pantoken-abc" },
      }),
    ];
    const { groups } = filterSessions(sessions, active);
    expect(groups.map((g) => g.cwd)).toEqual(["/proj"]); // parent basename, not worktree's
  });

  test("a reaped worktree session still groups under its parent (base retained)", () => {
    const sessions = [
      entry({
        path: "/wt",
        cwd: "/proj-pantoken-abc",
        // Worktree dir cleaned up: `reaped` set, but `base` retained so grouping survives.
        worktree: {
          path: "/proj-pantoken-abc",
          base: "/proj",
          name: "pantoken-abc",
          reaped: true,
        },
      }),
      entry({ path: "/main", cwd: "/proj" }),
    ];
    const { groups } = filterSessions(sessions, active);
    // Still one group under the parent — no lonely "proj-pantoken-abc" group after reaping.
    expect(groups.map((g) => g.cwd)).toEqual(["/proj"]);
    expect(groups[0].items.map((i) => i.path).sort()).toEqual(["/main", "/wt"]);
  });

  test("a hand-made workspace (no `worktree` field) keeps its own group", () => {
    const sessions = [
      entry({ path: "/main", cwd: "/proj" }),
      entry({ path: "/ws", cwd: "/proj-pantoken-abc" }), // no worktree field → own group
    ];
    const { groups } = filterSessions(sessions, active);
    expect(groups.map((g) => g.cwd).sort()).toEqual([
      "/proj",
      "/proj-pantoken-abc",
    ]);
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
