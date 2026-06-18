// The archive index: pilot's source of truth for which sessions the operator has
// archived (option B). Keyed by the session's .jsonl path — stable, since pi names
// session files by timestamp and never moves them, and it's the same key the client
// sends for openSession.
//
// Why an index and not pi's `appendCustomEntry`: pi's `listAll()` (what the sidebar is
// built from) parses messages + the session name and throws away custom entries, so a
// flag written into the JSONL would be write-only — reading it back means re-opening and
// scanning every session file, on top of the full read `listAll` already does. A small
// path-keyed set keeps `listSessions` an in-memory lookup with zero extra reads.
//
// This is STATE, not a cache: it is never rebuilt from session files, so deleting the
// backing file un-archives everything (a recoverable loss for a single-user tool). It
// lives under config.dataDir (XDG state dir) next to the VAPID keypair + push subs.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config.js";

export function defaultArchiveFile(): string {
  return join(config.dataDir, "archived.json");
}

export class ArchiveStore {
  private archived = new Set<string>();

  constructor(private readonly file: string = defaultArchiveFile()) {
    mkdirSync(dirname(file), { recursive: true });
    this.load();
  }

  has(path: string): boolean {
    return this.archived.has(path);
  }

  /** Set/clear the archived flag for a session path. Persists only on an actual change. */
  set(path: string, archived: boolean): void {
    const changed = archived
      ? !this.archived.has(path)
      : this.archived.has(path);
    if (!changed) return;
    if (archived) this.archived.add(path);
    else this.archived.delete(path);
    this.persist();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const arr = JSON.parse(readFileSync(this.file, "utf8")) as string[];
      for (const p of arr) this.archived.add(p);
      if (arr.length)
        console.log(`[archive] loaded ${arr.length} archived session(s)`);
    } catch (e) {
      console.error("[archive] failed to load index", e);
    }
  }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify([...this.archived], null, 2));
  }
}
