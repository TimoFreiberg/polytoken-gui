// Per-session transcript scroll position, persisted to localStorage so switching away
// from a warmed session and back restores where you were reading instead of always
// jumping to the live tail. Mirrors the draft/font-scale/theme persistence shape.
//
// What we store: a RATIO (scrollTop / scrollHeight) plus an `atBottom` flag.
//
// The ratio places you at the same RELATIVE position when you were scrolled up — content
// can grow between visits (the agent appended a turn while the session was backgrounded,
// images decoded, markstream finalized), so a raw scrollTop would land at the wrong spot.
//
// The `atBottom` flag is NOT derivable from the ratio: if you were pinned at the live
// tail of a 1000px transcript and it grew to 2000px while you were away, the saved ratio
// (~0.6) would land you mid-transcript, not at the new bottom. So we record "you were at
// the bottom" explicitly and restore to the live tail in that case — which is what you
// want ("I was at the end; put me at the end, newest content and all"). Only a genuinely
// scrolled-up position restores by ratio.

const KEY = "pantoken.scrollPositions";

// Distance from the bottom (px) within which we treat the reader as "at the live tail".
// Matches the `pinned` threshold in Transcript.svelte so the two agree on "at bottom".
export const BOTTOM_GAP = 80;

type SavedPosition = { ratio: number; atBottom: boolean; at: number };

export function loadScrollPositions(): Record<string, SavedPosition> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, SavedPosition> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      // Tolerate older/corrupt entries: a valid record has a numeric ratio in [0,1].
      // `atBottom` is newer — legacy entries without it default to false (restore by ratio).
      if (v && typeof v === "object") {
        const r = (v as { ratio?: unknown }).ratio;
        if (typeof r === "number" && r >= 0 && r <= 1) {
          out[k] = {
            ratio: r,
            atBottom: (v as { atBottom?: unknown }).atBottom === true,
            at: ((v as { at?: unknown }).at as number) ?? Date.now(),
          };
        }
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function persistScrollPositions(
  map: Record<string, SavedPosition>,
): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // Storage full / unavailable (private mode) — positions stay in-memory this session.
  }
}

/** Record where the user is reading in `sessionId`. `scrollTop`/`scrollHeight`/`clientHeight`
 *  come from the scroller; a ratio is derived so a later restore survives content growth, and
 *  `atBottom` is recorded so a session left at the live tail restores to the (possibly grown)
 *  tail rather than a stale proportional spot. */
export function saveScrollPosition(
  map: Record<string, SavedPosition>,
  sessionId: string,
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): Record<string, SavedPosition> {
  if (scrollHeight <= 0) return map;
  const ratio = Math.min(1, Math.max(0, scrollTop / scrollHeight));
  const atBottom = scrollHeight - scrollTop - clientHeight < BOTTOM_GAP;
  return { ...map, [sessionId]: { ratio, atBottom, at: Date.now() } };
}

/** Drop a saved position (e.g. when a session is archived/deleted). */
export function forgetScrollPosition(
  map: Record<string, SavedPosition>,
  sessionId: string,
): Record<string, SavedPosition> {
  if (!(sessionId in map)) return map;
  const next = { ...map };
  delete next[sessionId];
  return next;
}

/** How to restore `sessionId` on focus:
 *   - `null`        — nothing saved; the caller falls back to the live bottom.
 *   - `"bottom"`    — was at the live tail; chase the (possibly grown) bottom.
 *   - `{ ratio }`   — was scrolled up; restore that proportional position, re-derived
 *                     against the CURRENT scrollHeight by the caller (content may have grown).
 *  Kept deliberately free of any DOM/scrollHeight read: the decision is stable, but turning
 *  a ratio into a pixel target must happen per settle-frame as late layout changes the height. */
export type RestorePlan = "bottom" | { ratio: number } | null;

export function planRestore(
  map: Record<string, SavedPosition>,
  sessionId: string,
): RestorePlan {
  const saved = map[sessionId];
  if (!saved) return null;
  if (saved.atBottom) return "bottom";
  return { ratio: saved.ratio };
}
