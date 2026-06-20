// Correlate a session's in-context messages (what pilot replays on seed) to their
// persisted pi tree entry ids, so a replayed transcript item can carry a branch handle
// for navigateTree. pi keeps the id on the SessionEntry wrapper, never on the message
// itself, so we align the replayed message list against the branch's message-entries.
//
// Compaction can rewrite the FRONT of the in-context list (old turns collapse into a
// summary message that has no matching message-entry), so we align from the TAIL — the
// recent turns, which is where branching is actually wanted — and STOP at the first
// divergence rather than risk a wrong-but-plausible match. A skipped message just gets
// no id (its branch button stays hidden); it never gets the wrong node. Inputs are
// pre-extracted to {role, text} so this stays pure and unit-testable without pi types.

export interface TextMsg {
  readonly role?: string;
  readonly text: string;
}
export interface TextEntry extends TextMsg {
  readonly id: string;
}

/** Returns an array aligned with `messages`: each slot holds the matching entry id, or
 *  `undefined` where alignment stopped (older-than-divergence, or counts exhausted). */
export function correlateEntryIds(
  messages: readonly TextMsg[],
  entries: readonly TextEntry[],
): (string | undefined)[] {
  const ids: (string | undefined)[] = new Array(messages.length).fill(
    undefined,
  );
  let mi = messages.length - 1;
  let ei = entries.length - 1;
  while (mi >= 0 && ei >= 0) {
    const m = messages[mi]!;
    const e = entries[ei]!;
    if (m.role === e.role && m.text === e.text) {
      ids[mi] = e.id;
      mi -= 1;
      ei -= 1;
    } else {
      break;
    }
  }
  return ids;
}
