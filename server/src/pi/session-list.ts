// Merging the two sources the session list draws from: sessions persisted on disk
// (SessionManager.listAll) and warm in-memory sessions not yet written there. pi only
// flushes a session's .jsonl after its first assistant message, so a just-created
// session lives only in the warm pool until then — without this merge it would be
// missing from the sidebar despite being the active, focused session. Pure so it can
// be unit-tested without booting a real pi driver.

import type { SessionListEntry } from "@pilot/protocol";

/** Combine warm (in-memory) and on-disk session entries, deduped by sessionId. A warm
 *  session that's also on disk keeps its richer disk entry — the warm one is a
 *  placeholder. Warm-only entries come first (a fresh session is the newest); callers
 *  that group/sort (the sidebar) re-order anyway. */
export function mergeSessionLists(
  onDisk: readonly SessionListEntry[],
  warm: readonly SessionListEntry[],
): SessionListEntry[] {
  const onDiskIds = new Set(onDisk.map((e) => e.sessionId));
  const warmOnly = warm.filter((e) => !onDiskIds.has(e.sessionId));
  return [...warmOnly, ...onDisk];
}
