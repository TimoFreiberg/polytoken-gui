import { defineConfig, devices } from "@playwright/test";

// The e2e backend runs on an OS-assigned FREE port (PILOT_AUTO_PORT=1 in the webServer
// command below) rather than a fixed one. This is deliberate: a fixed backend port has no
// Playwright reuse-guard (that only watches `url`, i.e. Vite), so a leaked/orphaned server
// squatting on it gets silently proxied to — every test then runs against stale code. A fresh
// free port per run makes orphans harmless. dev.ts ALSO ignores any inherited PILOT_PORT /
// PILOT_DATA_DIR in auto-port mode (PILOT_AUTO_PORT=1 here), so a run launched from inside
// the live desktop app — which exports both into the shell — never aims at, nor fights the
// PID lock of, the running app's backend or data dir. That makes `bun run test:e2e` safe to
// run as-is from an agent session; no env scrubbing needed.
//
// Vite needs a port Playwright knows up front (it health-checks `url`), and the config is
// re-evaluated per worker process, so this MUST be deterministic — a freshly-picked free
// port would differ between the webServer launcher and the workers. So it's a fixed default,
// overridable via PILOT_E2E_VITE_PORT so a second checkout can run e2e concurrently without
// fighting over 15173 (e.g. PILOT_E2E_VITE_PORT=25173).
const VITE_PORT = Number(process.env.PILOT_E2E_VITE_PORT) || 15173;

// The mock server holds a single shared session, so specs run serially and
// reset state via /debug/reset in beforeEach. We always start a fresh dev
// server on alternate ports so there is zero risk of colliding with the
// user's running pilot instance.
export default defineConfig({
  testDir: "./e2e",
  testMatch: /\.e2e\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${VITE_PORT}`,
    trace: "on-first-retry",
  },
  webServer: {
    command:
      `PILOT_DRIVER=mock PILOT_AUTO_PORT=1 ` +
      // Snappy live-refresh cadence so the meter/list climb within a test's timeout
      // (prod default is 1s); the mid-turn live-update specs depend on it.
      `PILOT_LIVE_REFRESH_MS=150 ` +
      `VITE_PORT=${VITE_PORT} bun run scripts/dev.ts`,
    url: `http://localhost:${VITE_PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1100, height: 850 },
      },
      testIgnore: /\.mobile\.e2e\.ts$/,
    },
    {
      // Pixel 7 is a Chromium-based mobile descriptor — avoids a WebKit download
      // while still exercising a phone viewport + touch.
      name: "mobile",
      use: { ...devices["Pixel 7"] },
      testMatch: /\.mobile\.e2e\.ts$/,
    },
  ],
});
