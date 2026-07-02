// Per-session append-only journal of seq-stamped driver events — the hub's
// primary event structure for protocol v2. One structure is simultaneously the
// seed source for connecting clients (fold from zero), the resume ring for
// reconnecting ones (tail replay), and the future Rust-hub core (a journaling
// router needs no server-side fold). Pure data + pure functions; the hub owns
// lifecycle (create on seed, bump on reset/reload, delete with the state).
//
// Invariant (property-tested): at every instant,
//   foldAll(buildSeed(journal).events) ≡ the hub's legacy folded SessionState.

import type {
  SessionDriverEvent,
  SessionRef,
  SessionState,
} from "@pilot/protocol";

/** Tail ring caps: whichever trips first evicts oldest frames into `compacted`.
 *  Bigger = a longer resumable gap for reconnecting clients, more RAM. A resume
 *  older than the tail degrades to a full seed — never an error. */
export const TAIL_MAX_FRAMES = 1024;
export const TAIL_MAX_BYTES = 256 * 1024;

/** One live ring entry: a stamped event awaiting possible tail-resume replay.
 *  `bytes` is the JSON-serialized length (UTF-16 units — close enough for a cap). */
export interface JournalFrame {
  readonly seq: number;
  readonly ev: SessionDriverEvent;
  readonly bytes: number;
}

export interface SessionJournal {
  /** Identity of this transcript build. Bumped when the transcript's identity
   *  changes (first attach, sessionReset, reload/branch reseed) — resume across
   *  a bump is impossible, clients must take a full seed. */
  epoch: number;
  /** Last assigned seq this epoch; 0 = nothing stamped yet. */
  seq: number;
  /** History prefix below the resume window: events evicted from the tail (or
   *  the original seed), delta-coalesced. No seqs needed — it's only foldable,
   *  never replayable. */
  compacted: SessionDriverEvent[];
  /** The live ring — the resume source. Oldest first. */
  tail: JournalFrame[];
  tailBytes: number;
}

export function createJournal(
  epoch: number,
  seed: readonly SessionDriverEvent[],
): SessionJournal {
  return {
    epoch,
    seq: 0,
    compacted: coalesceEvents(seed),
    tail: [],
    tailBytes: 0,
  };
}

/** Restart the journal under a new epoch (transcript identity changed). The new
 *  `seed` becomes the compacted prefix; the tail (and its seq space) resets. */
export function bumpEpoch(
  j: SessionJournal,
  epoch: number,
  seed: readonly SessionDriverEvent[],
): void {
  j.epoch = epoch;
  j.seq = 0;
  j.compacted = coalesceEvents(seed);
  j.tail = [];
  j.tailBytes = 0;
}

/** Stamp one event into the tail, evicting oldest frames into the compacted
 *  prefix when the ring overflows. Returns the assigned seq. A single event
 *  larger than the byte cap passes through the tail into `compacted` (the ring
 *  briefly holds it, then absorbs it — resume then degrades to a full seed). */
export function appendEvent(j: SessionJournal, ev: SessionDriverEvent): number {
  j.seq += 1;
  const frame: JournalFrame = {
    seq: j.seq,
    ev,
    bytes: JSON.stringify(ev).length,
  };
  j.tail.push(frame);
  j.tailBytes += frame.bytes;
  while (j.tail.length > TAIL_MAX_FRAMES || j.tailBytes > TAIL_MAX_BYTES) {
    const oldest = j.tail.shift();
    if (!oldest) break;
    j.tailBytes -= oldest.bytes;
    compactedAppend(j.compacted, oldest.ev);
  }
  return j.seq;
}

/** The seed for one connecting client: every journaled event, delta-coalesced,
 *  plus the {epoch, seq} watermark of the last event folded into it. */
export function buildSeed(j: SessionJournal): {
  epoch: number;
  seq: number;
  events: SessionDriverEvent[];
} {
  return {
    epoch: j.epoch,
    seq: j.seq,
    events: coalesceEvents([...j.compacted, ...j.tail.map((f) => f.ev)]),
  };
}

/** Append one event to the compacted prefix, merging into its last element when
 *  the pair is mergeable (same rule as {@link coalesceEvents}). */
function compactedAppend(
  compacted: SessionDriverEvent[],
  ev: SessionDriverEvent,
): void {
  const last = compacted[compacted.length - 1];
  const merged = last ? tryMerge(last, ev) : null;
  if (merged) compacted[compacted.length - 1] = merged;
  else compacted.push(ev);
}

/** Merge two ADJACENT events into one fold-equivalent event, or return null.
 *
 *  - assistantDelta + assistantDelta on the same effective channel concatenate.
 *    Safe purely by fold semantics: after folding the first delta an assistant
 *    bubble is open, so the second always appends to the same accumulator — the
 *    merged event (first's timestamp/entryId, joined text) folds byte-identically.
 *  - usageUpdated + usageUpdated keeps the later one (the fold overwrites
 *    `usage` wholesale, so only the last of an adjacent run matters).
 *
 *  Never mutates its inputs — journal events may be aliased by in-flight sends. */
function tryMerge(
  a: SessionDriverEvent,
  b: SessionDriverEvent,
): SessionDriverEvent | null {
  if (a.type === "assistantDelta" && b.type === "assistantDelta") {
    const chanA = a.channel ?? "text";
    const chanB = b.channel ?? "text";
    if (chanA !== chanB) return null;
    return { ...a, text: a.text + b.text };
  }
  if (a.type === "usageUpdated" && b.type === "usageUpdated") return b;
  return null;
}

/** Collapse adjacent mergeable events (see {@link tryMerge}). Fold-equivalent by
 *  construction; property-tested against every mock fixture script. */
export function coalesceEvents(
  events: readonly SessionDriverEvent[],
): SessionDriverEvent[] {
  const out: SessionDriverEvent[] = [];
  for (const ev of events) compactedAppend(out, ev);
  return out;
}

/** Synthesize a minimal event prefix that reproduces a folded state's NON-item
 *  fields: one `sessionOpened` carrying the meta projection, plus `hostUiRequest`
 *  events for the ambient statuses/widgets/title and the pending dialogs.
 *
 *  Used when the journal restarts at a `sessionReset` epoch bump: the fold
 *  preserves ref/title/config/queued/approvals/ambient across a reset (only
 *  `items` clears), so the restarted journal needs a prefix that carries them —
 *  an empty journal would seed reconnecting clients with a blank session.
 *  Property: foldAll(metaSeedEvents(state, …)) ≡ {...state, items: []}.
 *
 *  A reset arriving before any snapshot would leave the legacy state's `ref`
 *  null while this prefix sets it — harmless, and unreachable in practice: every
 *  driver seed starts with `sessionOpened`, so `ref` is set before a reset can
 *  arrive. */
export function metaSeedEvents(
  state: SessionState,
  sessionRef: SessionRef,
  timestamp: string,
): SessionDriverEvent[] {
  const ref = state.ref ?? sessionRef;
  const events: SessionDriverEvent[] = [
    {
      type: "sessionOpened",
      sessionRef: ref,
      timestamp,
      snapshot: {
        ref,
        // The fold never reads `workspace`; a structurally-valid stub suffices.
        workspace: { workspaceId: ref.workspaceId, path: "" },
        title: state.title,
        status: state.status,
        updatedAt: timestamp,
        config: state.config,
        ...(state.usage !== undefined && { usage: state.usage }),
        ...(state.facet !== undefined && { facet: state.facet }),
        ...(state.permissionMonitor !== undefined && {
          permissionMonitor: state.permissionMonitor,
        }),
        ...(state.adventurousHandoff !== undefined && {
          adventurousHandoff: state.adventurousHandoff,
        }),
        ...(state.notificationAutodrain !== undefined && {
          notificationAutodrain: state.notificationAutodrain,
        }),
        ...(state.activePlan !== undefined && { activePlan: state.activePlan }),
        // The fold maps a null goal to undefined, so a folded state never holds
        // null — but the interface allows it; guard both.
        ...(state.goal != null && { goal: state.goal }),
        flags: state.flags,
        todos: state.todos,
        mcpServers: state.mcpServers,
        queuedMessages: state.queued,
      },
    },
  ];
  for (const [key, text] of Object.entries(state.ambient.statuses))
    events.push({
      type: "hostUiRequest",
      sessionRef: ref,
      timestamp,
      request: { kind: "status", requestId: `meta-status-${key}`, key, text },
    });
  for (const w of Object.values(state.ambient.widgets))
    events.push({
      type: "hostUiRequest",
      sessionRef: ref,
      timestamp,
      request: {
        kind: "widget",
        requestId: `meta-widget-${w.key}`,
        key: w.key,
        lines: w.lines,
        placement: w.placement,
      },
    });
  if (state.ambient.title !== undefined)
    events.push({
      type: "hostUiRequest",
      sessionRef: ref,
      timestamp,
      request: {
        kind: "title",
        requestId: "meta-title",
        title: state.ambient.title,
      },
    });
  for (const req of state.pendingApprovals)
    events.push({
      type: "hostUiRequest",
      sessionRef: ref,
      timestamp,
      request: req,
    });
  return events;
}
