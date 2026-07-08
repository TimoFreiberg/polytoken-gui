import { defineConfig, devices } from "@playwright/test";

// LIVE tier config — SEPARATE from playwright.config.ts on purpose, so the default
// `bun run test:e2e` (mock, desktop+mobile) is byte-for-byte unchanged (AC.8). This
// tier boots the REAL PolytokenDriver over an in-process, corpus-backed fake daemon:
// PANTOKEN_DRIVER=fake (the fake driver lives in the Rust server only). Run it with
// `bun run test:e2e:live`.
//
// Same auto-port self-isolation as the mock config (PANTOKEN_AUTO_PORT=1: dev.ts grabs
// a free backend port + per-port data dir, ignoring any inherited PANTOKEN_PORT/
// PANTOKEN_DATA_DIR from a running app). Vite still needs a port Playwright knows up
// front; its own default here (15273) is distinct from the mock config's 15173 so
// the two tiers can run without fighting over Vite, overridable via
// PANTOKEN_E2E_LIVE_VITE_PORT.
const VITE_PORT = Number(process.env.PANTOKEN_E2E_LIVE_VITE_PORT) || 15273;

export default defineConfig({
  testDir: "./e2e/live",
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
      `PANTOKEN_DRIVER=fake PANTOKEN_AUTO_PORT=1 ` +
      // Snappy live-refresh cadence, matching the mock config (prod default is 1s).
      `PANTOKEN_LIVE_REFRESH_MS=150 ` +
      `VITE_PORT=${VITE_PORT} bun run scripts/dev.ts`,
    url: `http://localhost:${VITE_PORT}`,
    reuseExistingServer: false,
    // Generous: the Rust backend is `cargo run`, so a cold compile can precede the
    // first health check. CI pre-warms with `cargo build` to keep this comfortable.
    timeout: 180_000,
  },
  projects: [
    {
      name: "live-desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1100, height: 850 },
      },
    },
  ],
});
