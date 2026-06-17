import { defineConfig, devices } from "@playwright/test";

// The mock server holds a single shared session, so specs run serially and reset
// state via /debug/reset in beforeEach. Reuses an already-running `bun run dev`.
// PILOT_DRIVER=mock is required — the default is now the live pi driver.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
  },
  webServer: {
    command: "PILOT_DRIVER=mock bun run dev",
    url: "http://localhost:5173",
    // Reuse a running `bun run dev` if present; otherwise Playwright starts one.
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1100, height: 850 },
      },
      testIgnore: /\.mobile\.spec\.ts$/,
    },
    {
      // Pixel 7 is a Chromium-based mobile descriptor — avoids a WebKit download
      // while still exercising a phone viewport + touch.
      name: "mobile",
      use: { ...devices["Pixel 7"] },
      testMatch: /\.mobile\.spec\.ts$/,
    },
  ],
});
