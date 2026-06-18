// Sidebar session filtering: grouping by project dir + search + the active-only filter
// (hide archived and stale sessions). Pure so it can be unit-tested without the DOM; the
// Sidebar component just renders the result.

import type { SessionListEntry } from "@pilot/protocol";

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

/** Hidden by the active-only filter: archived or stale. Always false when showing all. */
export function isHidden(
  entry: SessionListEntry,
  now: number,
  showArchived: boolean,
): boolean {
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

/** Group sessions by project dir for the sidebar, applying the search query and the
 *  active-only filter. Items sort newest-first within a group; groups sort by their
 *  newest item. Empty groups are dropped — so a project whose sessions are all hidden
 *  (archived/stale) disappears from the active view entirely. */
export function filterSessions(
  sessions: readonly SessionListEntry[],
  { query, showArchived, now }: FilterOptions,
): FilterResult {
  const q = query.trim().toLowerCase();
  const hiddenCount = sessions.filter((s) =>
    isHidden(s, now, showArchived),
  ).length;

  const byCwd = new Map<string, SessionListEntry[]>();
  for (const s of sessions) {
    if (isHidden(s, now, showArchived)) continue;
    if (!matchesQuery(s, q)) continue;
    const arr = byCwd.get(s.cwd);
    if (arr) arr.push(s);
    else byCwd.set(s.cwd, [s]);
  }

  const groups = [...byCwd.entries()].map(([cwd, items]) => ({
    cwd,
    items: [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  }));
  groups.sort((a, b) =>
    (b.items[0]?.updatedAt ?? "").localeCompare(a.items[0]?.updatedAt ?? ""),
  );
  return { groups, hiddenCount };
}
