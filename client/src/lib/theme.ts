// Theme override. app.css carries the light palette on `:root` and the dark palette
// on `:root[data-theme="dark"]` (a single copy of the dark tokens). There is no
// `prefers-color-scheme` media query — instead we resolve the chosen mode to a
// CONCRETE `data-theme` ("light" | "dark") on <html>. "system" is resolved here via
// matchMedia (and re-resolved live when the OS flips). An inline script in index.html
// applies the same resolution pre-paint so there's no flash. Persisted per-device.

export type ThemeMode = "system" | "light" | "dark";

const KEY = "pilot.theme";

export function getThemeMode(): ThemeMode {
  if (typeof window === "undefined") return "system";
  const stored = localStorage.getItem(KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

/** Persist the mode and reflect it onto <html>. */
export function setThemeMode(mode: ThemeMode): void {
  if (typeof window === "undefined") return;
  if (mode === "system") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, mode);
  applyThemeMode(mode);
}

/** The concrete palette a mode resolves to right now. */
export function resolveTheme(mode: ThemeMode): "light" | "dark" {
  return resolveThemeMode(mode, systemPrefersDark());
}

/** The pure core of {@link resolveTheme}: a mode → concrete palette given whether the OS
 *  currently prefers dark. Split out (mirroring notify.ts's shouldNotify pattern) so the
 *  mode→palette mapping is unit-testable without a window/matchMedia dependency — the
 *  `system` branch is the only non-deterministic part, threaded in as a boolean. */
export function resolveThemeMode(
  mode: ThemeMode,
  prefersDark: boolean,
): "light" | "dark" {
  if (mode === "light" || mode === "dark") return mode;
  return prefersDark ? "dark" : "light";
}

/** Reflect a mode onto <html> as a concrete `data-theme`. The CSS has no media
 *  query, so "system" must resolve to an explicit value here. Also syncs the
 *  `theme-color` meta so the PWA/browser chrome (Android status bar, address bar)
 *  tracks the active palette instead of the static light value baked into index.html. */
export function applyThemeMode(mode: ThemeMode): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", resolveTheme(mode));
  syncThemeColor();
}

/** Point the `theme-color` meta at the resolved palette's `--bg`. Reads the computed
 *  token so it can't drift from the CSS (iOS standalone uses the static apple status-bar
 *  meta instead, which can't be set live). */
function syncThemeColor(): void {
  if (typeof document === "undefined") return;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const bg = getComputedStyle(document.documentElement)
    .getPropertyValue("--bg")
    .trim();
  if (bg) meta.setAttribute("content", bg);
}

/** Re-apply the theme when the OS preference flips, but only while in "system" mode. */
export function watchSystemTheme(): void {
  if (typeof window === "undefined" || !window.matchMedia) return;
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      if (getThemeMode() === "system") applyThemeMode("system");
    });
}

function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches === true
  );
}
