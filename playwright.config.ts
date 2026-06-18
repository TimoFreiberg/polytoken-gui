import { defineConfig, devices } from "@playwright/test";

// Fixed ports that won't collide with the user's running pilot instance
// (defaults: 8787 / 5173) or with deploy/run.sh (8787). Overridable via env so a
// second checkout/workspace can run its own e2e suite concurrently without
// fighting over these ports (e.g. PILOT_E2E_VITE_PORT=25173).
const SERVER_PORT = Number(process.env.PILOT_E2E_SERVER_PORT) || 18787;
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
      `PILOT_DRIVER=mock PILOT_PORT=${SERVER_PORT} ` +
      `PILOT_SERVER=http://localhost:${SERVER_PORT} ` +
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
