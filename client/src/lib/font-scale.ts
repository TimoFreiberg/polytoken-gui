// Per-device reading-size override for the transcript. Mirrors lib/theme.ts: a persisted
// scalar reflected onto a CSS custom property (--font-scale) on <html>, pre-painted by an
// inline script in index.html so there's no reflow flash. The transcript column multiplies
// its base font-size by this; chrome (header / composer / sidebar) is intentionally NOT
// scaled, so zooming changes what you read, not the controls. 1 = default.
//
// Why an app-level knob instead of the browser's ⌘+/⌘-: installed as a PWA (standalone)
// those shortcuts are often unavailable and don't persist per-app. This does, and survives
// reload. Persisted per-device.

const KEY = "pantoken.fontScale";
export const MIN_SCALE = 0.85;
export const MAX_SCALE = 1.7;
/** ~1px per step at the 16.5px transcript base; 1/16 keeps values clean (binary fractions). */
export const STEP = 0.0625;

/** Snap to a STEP multiple and clamp to [MIN, MAX]. Non-finite input falls back to 1. */
export function clampScale(n: number): number {
  if (!Number.isFinite(n)) return 1;
  const snapped = Math.round(n / STEP) * STEP;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, snapped));
}

export function getFontScale(): number {
  if (typeof window === "undefined") return 1;
  const raw = localStorage.getItem(KEY);
  if (raw === null) return 1;
  return clampScale(Number.parseFloat(raw));
}

/** Reflect a scale onto <html> as the --font-scale custom property. */
export function applyFontScale(scale: number): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty(
    "--font-scale",
    String(clampScale(scale)),
  );
}

/** Clamp, persist (drop the key at the 1 default so it tracks future base changes), apply.
 *  Returns the clamped value so callers can sync their own reactive copy. */
export function setFontScale(scale: number): number {
  const clamped = clampScale(scale);
  if (typeof window !== "undefined") {
    if (clamped === 1) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(clamped));
  }
  applyFontScale(clamped);
  return clamped;
}
