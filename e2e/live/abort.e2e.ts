import { expect, test } from "@playwright/test";
import { driveLive, gotoFreshLive } from "./helpers.js";

// LIVE tier (PANTOKEN_DRIVER=fake). See streaming.e2e.ts for the structural-only +
// unrun-in-session caveats.

test.beforeEach(async ({ page }) => {
  await gotoFreshLive(page);
});

test("an aborted turn clears the running affordances", async ({ page }) => {
  await driveLive(page, "abort");

  // The abort corpus runs a turn then cancels it (turn_cancelled). Structurally the
  // turn must not be left stuck "running": the Stop pill and working indicator both
  // clear once the cancel lands. (A tighter assertion — the Stop pill visible mid-turn
  // then cleared — would need a hold scenario the frozen corpus doesn't carry; tighten
  // if such a capture is added.)
  await expect(page.locator(".composer-wrap .stop")).toHaveCount(0, {
    timeout: 10_000,
  });
  await expect(page.getByTestId("working-indicator")).toHaveCount(0);
});
