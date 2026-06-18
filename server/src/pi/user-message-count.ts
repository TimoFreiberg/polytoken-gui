// Counting the operator's own turns in a session file.
//
// pi's SessionInfo.messageCount counts every message entry — user prompts, assistant
// replies, AND toolResult messages. A tool-heavy session shows "55 msg" for what was
// really 4 human prompts. The sidebar wants the human count, so we re-scan the .jsonl
// and count only entries whose message role is "user".
//
// This mirrors pi's own buildSessionInfo line-walk, but inspects nothing but the role,
// so it's far lighter than loading a session into an AgentSession. listAll() already
// streamed every file once; to avoid doing it again on every sidebar refresh we cache
// the result keyed by the file's mtime + pi's own total message count. Either changing
// (a new turn appended, the file rewritten) invalidates the entry — no extra stat()
// call, since both come free from the SessionInfo we already have.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

interface CacheEntry {
  readonly mtimeMs: number;
  readonly total: number;
  readonly userCount: number;
}

const cache = new Map<string, CacheEntry>();

/** Number of role-"user" messages in a session file. `mtimeMs` + `total` (pi's
 *  full message count) form the cache key — both are already known from the
 *  SessionInfo, so a steady sidebar refresh re-reads only files that changed. */
export async function countUserMessages(
  path: string,
  mtimeMs: number,
  total: number,
): Promise<number> {
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === mtimeMs && hit.total === total)
    return hit.userCount;

  const userCount = await scanUserMessages(path);
  cache.set(path, { mtimeMs, total, userCount });
  return userCount;
}

async function scanUserMessages(path: string): Promise<number> {
  let userCount = 0;
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      if (!line) continue;
      // Cheap pre-filter: only "message" entries carry a role, and only "user" ones
      // count. Skip the JSON.parse for lines that can't match.
      if (!line.includes('"user"')) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // a torn final line on a session being written — ignore it
      }
      if (
        entry &&
        typeof entry === "object" &&
        (entry as { type?: unknown }).type === "message" &&
        (entry as { message?: { role?: unknown } }).message?.role === "user"
      ) {
        userCount++;
      }
    }
  } finally {
    rl.close();
  }
  return userCount;
}
