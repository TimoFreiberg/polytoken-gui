// Shared `fd`-backed file search for the @-mention autocomplete — used by both the
// pi driver and the polytoken driver. Extracted from pi-driver.ts so both drivers
// share one implementation of the path-escaping, cap, and spawn-and-collect logic.
//
// The polytoken driver uses the daemon's GET /files for the index (daemon-native,
// ignore-aware) but falls back to this `fd` search for a truncated-index query —
// the same fallback the pi driver uses. `fd` is .gitignore-aware, lists files + dirs,
// follows symlinks, and includes dotfiles (excluding .git).

import type { FileInfo } from "@pilot/protocol";

/** `fd` matches its pattern as a regex by default, so a raw query is wrong twice over:
 *  path chars like `.` become wildcards, and unbalanced metacharacters (`(`, `[`) make
 *  `fd` exit non-zero — a file literally named `foo[1].txt` would be uncompletable. Port
 *  pi's escaping: regex-escape each path segment, joining on a separator class. Mirrors
 *  `escapeRegex`/`buildFdPathQuery` in pi's TUI `autocomplete.ts`. */
export function escapeFdRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildFdPathQuery(query: string): string {
  const normalized = query.replace(/\\/g, "/");
  if (!normalized.includes("/")) {
    return escapeFdRegex(normalized);
  }
  const hasTrailingSeparator = normalized.endsWith("/");
  const trimmed = normalized.replace(/^\/+|\/+$/g, "");
  if (!trimmed) return normalized;
  const separatorPattern = "[\\\\/]";
  const segments = trimmed.split("/").filter(Boolean).map(escapeFdRegex);
  if (segments.length === 0) return normalized;
  let pattern = segments.join(separatorPattern);
  if (hasTrailingSeparator) pattern += separatorPattern;
  return pattern;
}

/** How many entries the prefetched @-mention index carries. The client fuzzy-matches
 *  this locally (no per-keystroke round-trip); only when a cwd overflows the cap does it
 *  fall back to a server `fd` search. Generous — `fd` is .gitignore-aware so the count is
 *  source files, not vendored trees — but bounded so the per-switch payload stays small. */
export const FILE_INDEX_CAP = 2000;
/** Result cap for the per-query fallback search (only fires on a truncated index). */
export const FILE_QUERY_CAP = 50;

/** Shared fd flags for both the index and the fallback query: cap results, list files +
 *  dirs, follow symlinks, include dotfiles, exclude the `.git` tree. `.gitignore`-aware
 *  by default. Mirrors pi's TUI `autocomplete.ts`. */
export function baseFdArgs(cwd: string, maxResults: number): string[] {
  return [
    "--base-directory",
    cwd,
    "--max-results",
    String(maxResults),
    "--type",
    "f",
    "--type",
    "d",
    "--follow",
    "--hidden",
    "--exclude",
    ".git",
    "--exclude",
    ".git/*",
    "--exclude",
    ".git/**",
  ];
}

/** Spawn fd and collect its stdout lines. Resolves `[]` on spawn failure, non-zero exit
 *  (fd exits 1 when nothing matches), or a 5s timeout — silence is fine in a web UI (the
 *  menu just stays closed / the index stays empty). */
export function runFd(cwd: string, args: string[]): Promise<string[]> {
  return new Promise((resolve) => {
    const child = Bun.spawn(["fd", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill();
        resolve([]);
      }
    }, 5_000);

    const finish = (lines: string[]) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(lines);
    };

    void (async () => {
      let stdout = "";
      try {
        stdout = await new Response(child.stdout).text();
      } catch {
        // fd not found or errored — return empty.
        finish([]);
        return;
      }
      const exitCode = await child.exited;
      if (exitCode !== 0) {
        // fd exits 1 when no matches; treat like empty.
        finish([]);
        return;
      }
      finish(stdout.trim().split("\n").filter(Boolean));
    })();
  });
}

/** Parse fd's path lines into `FileInfo[]`: normalize separators to forward slashes,
 *  strip fd's trailing "/" on directories, and drop any stray `.git` entries (fd's
 *  exclude should catch them — belt-and-suspenders). */
export function parseFdLines(lines: string[]): FileInfo[] {
  const results: FileInfo[] = [];
  for (const line of lines) {
    const normalized = line.replaceAll("\\", "/");
    const isDirectory = normalized.endsWith("/");
    const path = isDirectory ? normalized.slice(0, -1) : normalized;
    if (
      path === ".git" ||
      path.startsWith(".git/") ||
      path.includes("/.git/")
    ) {
      continue;
    }
    results.push({ path, isDirectory });
  }
  return results;
}

/** Build the full @-mention index for `cwd`: one unfiltered fd over the tree, capped at
 *  {@link FILE_INDEX_CAP}. Requests one extra entry so we can report `truncated` when the
 *  cwd overflows the cap (the client then falls back to {@link listFilesWithFd}). */
export async function listFileIndexWithFd(
  cwd: string,
): Promise<{ files: FileInfo[]; truncated: boolean }> {
  const files = parseFdLines(
    await runFd(cwd, baseFdArgs(cwd, FILE_INDEX_CAP + 1)),
  );
  const truncated = files.length > FILE_INDEX_CAP;
  return {
    files: truncated ? files.slice(0, FILE_INDEX_CAP) : files,
    truncated,
  };
}

/** Fallback @-mention search in `cwd` via fd, used only when the index was truncated.
 *  `fd` matches as a regex, so the query is escaped via `buildFdPathQuery` (see above);
 *  `--full-path` is added for path-bearing queries. Capped at {@link FILE_QUERY_CAP}. */
export async function listFilesWithFd(
  cwd: string,
  query: string,
): Promise<FileInfo[]> {
  const args = baseFdArgs(cwd, FILE_QUERY_CAP);
  if (query.replace(/\\/g, "/").includes("/")) {
    args.push("--full-path");
  }
  if (query) {
    args.push(buildFdPathQuery(query));
  }
  return parseFdLines(await runFd(cwd, args));
}
