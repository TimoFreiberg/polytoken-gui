// resolveThemeMode is the pure core of theme resolution (mode → concrete palette given
// whether the OS prefers dark). Split out of resolveTheme — which called the private
// systemPrefersDark() (window.matchMedia) directly, making it untestable without a DOM —
// mirroring notify.ts's shouldNotify pattern: thread the env-dependent boolean in as a
// param so the mapping is unit-testable. resolveTheme itself stays covered for the
// env-defensive default (no window → "system" resolves to "light").

import { describe, expect, test } from "bun:test";
import { resolveTheme, resolveThemeMode } from "./theme.js";

describe("resolveThemeMode (pure)", () => {
  test('"light" and "dark" pass through unchanged regardless of OS preference', () => {
    // An explicit choice overrides the system preference in both directions.
    expect(resolveThemeMode("light", true)).toBe("light");
    expect(resolveThemeMode("light", false)).toBe("light");
    expect(resolveThemeMode("dark", true)).toBe("dark");
    expect(resolveThemeMode("dark", false)).toBe("dark");
  });

  test('"system" follows the OS preference', () => {
    expect(resolveThemeMode("system", true)).toBe("dark");
    expect(resolveThemeMode("system", false)).toBe("light");
  });

  test('"system" with no dark preference defaults to light (never null/undefined)', () => {
    // The safe default — a missing/false preference must yield a concrete palette,
    // not something the caller has to guard against.
    const r = resolveThemeMode("system", false);
    expect(r === "light" || r === "dark").toBe(true);
    expect(r).toBe("light");
  });
});

describe("resolveTheme (env-bound wrapper)", () => {
  test('under bun test (no window), "system" defensively resolves to "light"', () => {
    // systemPrefersDark() returns false when window is undefined, so the wrapper
    // doesn't throw and yields the light palette — the same fallback the SSR/pre-paint
    // inline script relies on. Pins that the split didn't break the public surface.
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
    expect(resolveTheme("system")).toBe("light");
  });
});
