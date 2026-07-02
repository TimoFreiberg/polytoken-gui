// Pilot-local settings persisted across restarts. Distinct from the daemon's global config
// (auth.json + the daemon's settings, reached through the driver): these are pilot's OWN knobs,
// stored as a small JSON file in the data dir alongside the VAPID key / archive index.
// Currently just the login-shell override (see login-env.ts); structured as an object
// so future pilot-local settings slot in without a new store.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PilotSettings } from "@pilot/protocol";
import { config } from "./config.js";

const DEFAULTS: PilotSettings = {
  loginShell: null,
  backgroundModel: null,
};

function settingsPath(): string {
  return join(config.dataDir, "pilot-settings.json");
}

/** Read pilot-local settings, layering persisted values over defaults. Never throws —
 *  a missing file is just defaults; a corrupt file loud-warns and falls back (house
 *  rule: surface, don't silently lose, but don't brick startup over a bad settings
 *  file either). */
export function readPilotSettings(): PilotSettings {
  const path = settingsPath();
  if (!existsSync(path)) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(
      readFileSync(path, "utf8"),
    ) as Partial<PilotSettings>;
    return { ...DEFAULTS, ...raw };
  } catch (e) {
    console.error(`[settings] failed to parse ${path}; using defaults`, e);
    return { ...DEFAULTS };
  }
}

/** Merge a patch into persisted settings and write it back. Returns the new full
 *  settings so callers can broadcast the authoritative value. */
export function writePilotSettings(
  patch: Partial<PilotSettings>,
): PilotSettings {
  const next: PilotSettings = { ...readPilotSettings(), ...patch };
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(settingsPath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}
