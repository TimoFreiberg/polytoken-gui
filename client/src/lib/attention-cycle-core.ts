// The pure decision core of the attention-surface cycle, split out of
// attention-cycle.svelte.ts (which wraps it with `$state` runes) so it is
// unit-testable without a Svelte compiler — mirroring transitions.ts's
// revealDuration / wake-lock's createWakeLock pattern.
//
// Given the current focused surface (null = the implicit "transcript" home
// position) and the list of active surfaces (always including "transcript"),
// compute the next focused surface and the set of surfaces that should be
// minimized vs. restored. The caller applies these to its reactive state.

import type { AttentionSurface } from "./attention-cycle.svelte.js";

export interface CycleResult {
  focused: AttentionSurface;
  // Surfaces to minimize (the previously focused one, if it isn't transcript).
  minimize: AttentionSurface[];
}

/**
 * Compute the next focus + minimize set for a ⌘\ press.
 *
 * - `focused === null` means the user is implicitly on transcript (home). The
 *   first press ADVANCES past transcript rather than landing on it (a no-op).
 * - If the currently focused surface is no longer active, restart from
 *   transcript.
 * - Otherwise advance one step forward in `activeSurfaces`, wrapping.
 *
 * The previously focused non-transcript surface is minimized; the newly focused
 * surface is restored (un-minimized). Returns null when there is nothing to
 * cycle to (empty active list).
 */
export function planCycle(
  current: AttentionSurface | null,
  activeSurfaces: AttentionSurface[],
): CycleResult | null {
  if (activeSurfaces.length === 0) return null;

  let nextIndex: number;
  if (current === null) {
    // Implicit "transcript is focused" — advance from it.
    const tIdx = activeSurfaces.indexOf("transcript");
    nextIndex = tIdx === -1 ? 0 : (tIdx + 1) % activeSurfaces.length;
  } else if (!activeSurfaces.includes(current)) {
    // Focused surface is no longer active — restart from transcript.
    nextIndex = activeSurfaces.indexOf("transcript");
    if (nextIndex === -1) nextIndex = 0;
  } else {
    nextIndex = (activeSurfaces.indexOf(current) + 1) % activeSurfaces.length;
  }
  const next = activeSurfaces[nextIndex];
  if (!next) return null; // unreachable given length>0, satisfies noUncheckedIndexedAccess.

  const minimize: AttentionSurface[] = [];
  if (current && current !== "transcript" && activeSurfaces.includes(current))
    minimize.push(current);

  return { focused: next, minimize };
}
