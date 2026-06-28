// Parsing the daemon's `GET /files` response into pilot's `FileInfo[]`.
//
// GET /files returns `{files: string[]}` — project-relative paths, alphabetical,
// with a trailing `/` on directories (spike §8 / the OpenAPI FileCatalogResponse).
// This is the daemon-native @-mention index that replaces pilot's `fd`-based index
// under the polytoken driver. The daemon is ignore-aware (.gitignore,
// .claudeignore, .polytokenignore) and excludes dotfiles + the project private
// dir, so the set is already bounded — pilot just splits the trailing-`/` dir
// marker. Belt-and-suspenders: drop stray `.git` entries (the daemon excludes
// them, but a config edge case shouldn't leak them into the menu).
//
// Pure — unit-testable without a daemon. Extracted from the driver so the parse
// path is tested in isolation (mirrors the models.ts / commands.ts pattern).

import type { FileInfo } from "@pilot/protocol";

/** Parse the daemon's GET /files string list (dirs trailing `/`) into `FileInfo[]`.
 *  The daemon already normalizes to forward slashes + alphabetical order; we just
 *  split the trailing-`/` dir marker. Drops stray `.git` entries defensively. */
export function parseFileCatalog(paths: readonly string[]): FileInfo[] {
  const out: FileInfo[] = [];
  for (const p of paths) {
    if (typeof p !== "string" || !p) continue;
    const isDirectory = p.endsWith("/");
    const path = isDirectory ? p.slice(0, -1) : p;
    if (
      path === ".git" ||
      path.startsWith(".git/") ||
      path.includes("/.git/")
    ) {
      continue;
    }
    out.push({ path, isDirectory });
  }
  return out;
}
