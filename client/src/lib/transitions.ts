import { slide } from "svelte/transition";
import type { SlideParams, TransitionConfig } from "svelte/transition";

// The one collapse/disclosure animation for the app: a height+opacity glide, matching the
// sidebar project groups (the reference). Wraps Svelte's `slide` so every collapsible
// section shares a single duration AND honours `prefers-reduced-motion` — reduced-motion
// users get an instant snap (duration 0) instead of the glide, the same courtesy the
// shared <Chevron> already extends to its rotation.
//
// Usage: `transition:reveal` (default 160ms) or `transition:reveal={{ duration, axis }}`.
export const REVEAL_MS = 160;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function reveal(
  node: Element,
  params: SlideParams = {},
): TransitionConfig {
  const duration = prefersReducedMotion() ? 0 : (params.duration ?? REVEAL_MS);
  return slide(node, { ...params, duration });
}
