// Sidebar session filtering: grouping by project dir + search + the active-only filter
// (hide archived and stale sessions). Pure so it can be unit-tested without the DOM; the
// Sidebar component just renders the result.

import type { SessionListEntry } from "@pantoken/protocol";

/** A session is "stale" once it's gone untouched for over a week. Client-side per the
 *  TODO: `Date.now() - updatedAt > 7d`. */
export const STALE_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionGroup {
  cwd: string;
  items: SessionListEntry[];
}

/** Maximum sessions shown per project group before a "Show N more" button appears.
 *  Mirrors Codex Desktop's per-project cap. The limit is display-only — the full
 *  list is still in `group.items`; clicking "Show N more" reveals the rest. */
export const SESSIONS_PER_GROUP = 5;

export interface GroupSplit {
  visible: SessionListEntry[];
  hidden: SessionListEntry[];
}

/** Split a group's sorted items into the visible cap and the hidden remainder.
 *  The viewed/running session (in `pinnedIds`) is always kept visible even if it
 *  falls outside the first `limit` — it's pulled into the visible slice and the
 *  next-highest non-pinned session is pushed into the remainder instead. This
 *  prevents the limit from hiding the session you're currently looking at (Q4).
 *  When `limit` is 0 or items.length <= limit, all items are visible. */
export function splitGroup(
  items: readonly SessionListEntry[],
  limit: number,
  pinnedIds?: ReadonlySet<string>,
): GroupSplit {
  if (limit <= 0 || items.length <= limit) {
    return { visible: [...items], hidden: [] };
  }
  // First `limit` items are visible by default.
  const visible = items.slice(0, limit);
  const hidden = items.slice(limit);
  // If a pinned session fell into the hidden slice, swap it with the
  // lowest-priority visible non-pinned session so the pinned one stays shown.
  const pinnedInHiddenIdx = hidden.findIndex((s) => pinnedIds?.has(s.sessionId));
  if (pinnedInHiddenIdx !== -1) {
    // Find the last visible session that isn't pinned — swap it down.
    let swapIdx = -1;
    for (let i = visible.length - 1; i >= 0; i--) {
      const v = visible[i];
      if (v && !pinnedIds?.has(v.sessionId)) {
        swapIdx = i;
        break;
      }
    }
    if (swapIdx !== -1) {
      // swapIdx and pinnedInHiddenIdx are both valid indices here.
      const tmp = visible[swapIdx]!;
      visible[swapIdx] = hidden[pinnedInHiddenIdx]!;
      hidden[pinnedInHiddenIdx] = tmp;
    }
    // If every visible session is pinned (rare), the pinned one stays hidden —
    // acceptable degenerate edge; all are pinned so visibility is maximized.
  }
  return { visible, hidden };
}

export interface FilterOptions {
  query: string;
  /** false = active-only (hide archived + stale); true = show everything. */
  showArchived: boolean;
  now: number;
  /** Session IDs to keep visible even when the active-only filter would hide them
   *  (archived or stale): the session currently shown in the transcript and every
   *  currently-running session. Hiding the row you're looking at — or one that's
   *  actively working — is more confusing than the tidiness it buys. Omit = none
   *  pinned. */
  pinnedIds?: ReadonlySet<string>;
}

export interface FilterResult {
  groups: SessionGroup[];
  /** How many sessions the active-only filter is hiding (archived or stale), regardless
   *  of the search query — drives the "(N hidden)" hint on the filter toggle. */
  hiddenCount: number;
}

/** True if `entry` was last modified more than a week ago. An unparseable timestamp
 *  counts as NOT stale — we never hide a session we can't date. */
export function isStale(entry: SessionListEntry, now: number): boolean {
  const t = Date.parse(entry.updatedAt);
  return Number.isFinite(t) && now - t > STALE_MS;
}

/** Hidden by the active-only filter: archived or stale. Always false when showing all,
 *  or when the session is pinned (focused in the transcript / currently running). */
export function isHidden(
  entry: SessionListEntry,
  now: number,
  showArchived: boolean,
  pinnedIds?: ReadonlySet<string>,
): boolean {
  if (pinnedIds?.has(entry.sessionId)) return false;
  return !showArchived && (entry.archived || isStale(entry, now));
}

function matchesQuery(entry: SessionListEntry, q: string): boolean {
  if (!q) return true;
  return (
    (entry.displayName ?? "").toLowerCase().includes(q) ||
    (entry.preview ?? "").toLowerCase().includes(q) ||
    entry.cwd.toLowerCase().includes(q)
  );
}

/** The display name for a project group: the final path segment of its cwd. Kept here
 *  (not imported from the Sidebar component) so this module stays DOM-free + unit-testable. */
function projectName(cwd: string): string {
  const parts = cwd.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || cwd;
}

/** The sidebar sort key for a session: when the operator last sent a message here. This
 *  is Claude-app-style "most recently used on top", but — unlike `updatedAt`, which the
 *  agent bumps on every streamed turn — it only moves when you actually interact, so a
 *  running session holds its place instead of jumping around as it emits tokens. Falls
 *  back to `updatedAt` if the server didn't supply it. */
function lastInteractionKey(entry: SessionListEntry): string {
  return entry.lastUserMessageAt || entry.updatedAt;
}

/** The project directory a session belongs to for draft-prefill and grouping:
 *  a pantoken-created worktree session's parent repo (`worktree.base`), else
 *  its own cwd. Mirrors the `groupKey` used by `filterSessions` so the
 *  new-session draft's default project always matches the sidebar group the
 *  session appears under. */
export function projectCwdOf(entry: SessionListEntry): string {
  return entry.worktree?.base ?? entry.cwd;
}

/** Group sessions by project dir for the sidebar, applying the search query and the
 *  active-only filter. Within a group, sessions sort by last-interaction time, newest
 *  first ({@link lastInteractionKey}). Groups sort alphabetically by project name (the
 *  cwd's basename), case-insensitive. Empty groups are dropped — so a project whose
 *  sessions are all hidden (archived/stale) disappears from the active view. */
export function filterSessions(
  sessions: readonly SessionListEntry[],
  { query, showArchived, now, pinnedIds }: FilterOptions,
): FilterResult {
  const q = query.trim().toLowerCase();
  const hiddenCount = sessions.filter((s) =>
    isHidden(s, now, showArchived, pinnedIds),
  ).length;

  const byCwd = new Map<string, SessionListEntry[]>();
  for (const s of sessions) {
    if (isHidden(s, now, showArchived, pinnedIds)) continue;
    if (!matchesQuery(s, q)) continue;
    // A pantoken-created worktree session groups under the repo it was forked from
    // (`worktree.base`), not its own worktree-basename cwd — so it interleaves with the
    // parent project's main-tree sessions instead of forming its own group. Hand-made
    // workspaces (no `worktree` field) keep their own group, by design.
    const groupKey = projectCwdOf(s);
    const arr = byCwd.get(groupKey);
    if (arr) arr.push(s);
    else byCwd.set(groupKey, [s]);
  }

  const groups = [...byCwd.entries()].map(([cwd, items]) => ({
    cwd,
    // Most recently used on top, by last-interaction time (not agent activity), so a
    // streaming session doesn't leapfrog its siblings as its `updatedAt` keeps bumping.
    items: [...items].sort((a, b) =>
      lastInteractionKey(b).localeCompare(lastInteractionKey(a)),
    ),
  }));
  // Projects A→Z by display name, case-insensitive, with the full cwd as a stable
  // tiebreaker when two projects share a basename. (Sessions within a group stay
  // most-recently-used-first, sorted above.)
  groups.sort((a, b) => {
    const byName = projectName(a.cwd).localeCompare(
      projectName(b.cwd),
      undefined,
      {
        sensitivity: "base",
      },
    );
    return byName !== 0 ? byName : a.cwd.localeCompare(b.cwd);
  });
  return { groups, hiddenCount };
}
