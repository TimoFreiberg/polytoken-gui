// The worktree index: pilot's record of the jj/git worktrees IT created (via the
// new-session worktree toggle), keyed by the worktree dir — which is the session's cwd.
// Mirrors ArchiveStore: a small persisted map so listSessions can flag worktree-backed
// sessions with an in-memory lookup, and so cleanup only ever touches worktrees pilot
// made (never a worktree the user manages by hand).
//
// This is STATE, not a cache: it's never rebuilt by scanning the disk, so deleting the
// backing file just makes pilot forget it owns those worktrees (a recoverable loss for a
// single-user tool). It lives under config.dataDir next to the archive index.
//
// Reaping is a TOMBSTONE, not a delete: once a worktree dir is removed, its entry stays
// in the index marked `reaped`. The live affordances (the ownership gate, the sidebar's
// clean-up/copy-path action) check `live()` and so stop treating it as a real worktree,
// but `get()` still returns its `base` so the (now archived/orphaned) session keeps
// grouping under its parent project instead of jumping into a lonely group named after
// the dead worktree dir. Tombstones are tiny and bounded by worktrees-ever-created.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config.js";
import type { WorktreeMeta } from "./pi/worktree.js";

export function defaultWorktreeFile(): string {
  return join(config.dataDir, "worktrees.json");
}

export class WorktreeStore {
  private byPath = new Map<string, WorktreeMeta>();
  // Paths whose worktree dir has been reaped. The meta stays in `byPath` (so `base`
  // survives for grouping); this set marks it as no-longer-a-live-worktree.
  private reaped = new Set<string>();

  constructor(private readonly file: string = defaultWorktreeFile()) {
    mkdirSync(dirname(file), { recursive: true });
    this.load();
  }

  /** The worktree pilot created (or once created) at this path (== a session cwd), or
   *  undefined. Returns reaped tombstones too — callers that need a *live* worktree (the
   *  cleanup ownership gate) must use {@link live} instead. Used for sidebar grouping +
   *  the subtitle, which want `base` even after the dir is gone. */
  get(path: string): WorktreeMeta | undefined {
    return this.byPath.get(path);
  }

  /** True if this path's worktree dir has been reaped (tombstoned). */
  isReaped(path: string): boolean {
    return this.reaped.has(path);
  }

  /** The worktree at this path only if it's still LIVE (not reaped) — the ownership gate
   *  for cleanup/archive reaping, so we never try to reap an already-gone dir twice. */
  live(path: string): WorktreeMeta | undefined {
    return this.reaped.has(path) ? undefined : this.byPath.get(path);
  }

  add(meta: WorktreeMeta): void {
    this.byPath.set(meta.path, meta);
    // Defensive: a path reused after a prior reap starts live again.
    this.reaped.delete(meta.path);
    this.persist();
  }

  /** Tombstone the worktree at `path`: keep its meta (for grouping) but mark it reaped so
   *  the live affordances and the ownership gate drop it. */
  markReaped(path: string): void {
    if (this.byPath.has(path) && !this.reaped.has(path)) {
      this.reaped.add(path);
      this.persist();
    }
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const arr = JSON.parse(readFileSync(this.file, "utf8")) as Array<
        WorktreeMeta & { reaped?: boolean }
      >;
      for (const { reaped, ...m } of arr) {
        this.byPath.set(m.path, m);
        if (reaped) this.reaped.add(m.path);
      }
      if (arr.length)
        console.log(`[worktree] loaded ${arr.length} tracked worktree(s)`);
    } catch (e) {
      console.error("[worktree] failed to load index", e);
    }
  }

  private persist(): void {
    const out = [...this.byPath.values()].map((m) =>
      this.reaped.has(m.path) ? { ...m, reaped: true } : m,
    );
    writeFileSync(this.file, JSON.stringify(out, null, 2));
  }
}
