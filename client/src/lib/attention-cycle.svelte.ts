// The shared controller for the ⌘\ attention-surface cycle (mirrors the
// image-viewer.svelte.ts singleton pattern). Surface components live in
// different parts of the tree (QnaInline + ApprovalLayer in the chat column),
// so a shared singleton they each read is cleaner than prop-drilling
// minimize/focus state.
//
// The cycle's three agent-driven surfaces, in order:
//   transcript → qna → approval → transcript

import { planCycle } from "./attention-cycle-core.js";

export type AttentionSurface = "transcript" | "qna" | "approval";

// Svelte 5 class with $state fields — the documented pattern for reactive
// singletons (mirrors image-viewer.svelte.ts). $effect reads of .focused and
// .minimized.* re-fire when these fields are mutated.
class AttentionController {
  focused = $state<AttentionSurface | null>(null);
  minimized = $state<Record<AttentionSurface, boolean>>({
    transcript: false,
    qna: false,
    approval: false,
  });

  cycle(activeSurfaces: AttentionSurface[]): void {
    const plan = planCycle(this.focused, activeSurfaces);
    if (!plan) return;
    for (const s of plan.minimize) this.minimized[s] = true;
    this.minimized[plan.focused] = false;
    this.focused = plan.focused;
  }

  restore(surface: AttentionSurface): void {
    this.minimized[surface] = false;
    this.focused = surface;
  }

  minimize(surface: AttentionSurface): void {
    this.minimized[surface] = true;
    if (this.focused === surface) this.focused = null;
  }

  clear(surface: AttentionSurface): void {
    if (this.focused === surface) this.focused = null;
    this.minimized[surface] = false;
  }
}

export const attention = new AttentionController();
