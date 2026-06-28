// Shared filesystem helpers for the new-session project picker. Both the pi driver
// and the polytoken driver need to (a) expand a GUI-supplied path (`~` → $HOME,
// resolve relative segments) and (b) list/stat directories on the SERVER's
// filesystem — the picker browses the server regardless of which device the
// client is on. Extracted here so the two drivers stay in lockstep and the pure
// helpers are unit-testable without a driver.

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { DirListing, PathStat } from "@pilot/protocol";
import type { Dirent } from "node:fs";

/** Expand a GUI-supplied path to an absolute one: `~`/`~/…` -> $HOME, otherwise
 *  resolve relative segments. `~otheruser` is left literal (we can't resolve
 *  another user's home) and falls through to the caller's existence check. */
export function resolveGuiPath(raw: string): string {
  const trimmed = raw.trim();
  const expanded =
    trimmed === "~" || trimmed.startsWith("~/")
      ? resolve(homedir(), `.${trimmed.slice(1)}`)
      : trimmed;
  return resolve(expanded);
}

/** Sort directory basenames for the picker: non-hidden first, then case-insensitive. */
export function compareDirNames(a: string, b: string): number {
  const aHidden = a.startsWith(".");
  const bHidden = b.startsWith(".");
  if (aHidden !== bHidden) return aHidden ? 1 : -1;
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

/** List the child directories of an absolute `dir` on the real filesystem (the
 *  new-session picker). Symlinks are followed so a symlinked project dir still
 *  shows. An unreadable `dir` (missing / not a directory / no permission) returns
 *  `error: true` with no entries — surfaced to the UI rather than masquerading as
 *  an empty folder. */
export function listDirOnDisk(dir: string): DirListing {
  const parent = dirname(dir);
  const parentOrNull = parent === dir ? null : parent;
  let dirents: Dirent[];
  try {
    dirents = readdirSync(dir, { withFileTypes: true }) as Dirent[];
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

/** Quick stat check for the new-session dir picker's inline validation hint.
 *  Returns whether `path` exists and whether it's a directory, following symlinks.
 *  Expands `~` first so a GUI path validates identically to `listDir`. */
export function statPathOnDisk(path: string): PathStat {
  const abs = resolveGuiPath(path);
  try {
    const s = statSync(abs);
    return { path: abs, exists: true, isDir: s.isDirectory() };
  } catch {
    return { path: abs, exists: false, isDir: false };
  }
}
