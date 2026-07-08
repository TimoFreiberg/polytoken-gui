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
    const groupKey = s.worktree?.base ?? s.cwd;
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
