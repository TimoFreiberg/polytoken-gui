// Color bands for the context-window rings (the composer meter + the sidebar rows),
// kept here so both render the identical scale. The tone names map 1:1 to CSS vars:
//   ok      → --ok      (green)        below half
//   warning → --warning (amber/yellow) half to three-quarters
//   accent  → --accent  (dark orange)  three-quarters to nearly-full
//   danger  → --danger  (red)          90% and up
export type ContextTone = "ok" | "warning" | "accent" | "danger";

/** Map a context-fill percentage to its color band. `null` (window known but the
 *  token count is pending, e.g. just after a compaction) draws no arc, so its tone is
 *  cosmetic — treat it as the calm/green end. */
export function contextTone(percent: number | null): ContextTone {
  if (percent === null) return "ok";
  if (percent >= 90) return "danger";
  if (percent >= 75) return "accent";
  if (percent >= 50) return "warning";
  return "ok";
}
