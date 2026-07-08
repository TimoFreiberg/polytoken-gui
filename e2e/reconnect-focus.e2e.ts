import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

// A dropped socket (a Tailscale flap on a phone) reconnects as a brand-new connection, which
// the hub registers focused on the empty landing. The client must re-assert the session it
// was reading, or the view snaps to a blank/landing pane mid-session. The mock's landing is
// the greeting, distinct from the session we open here, so the bug reproduces deterministically.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("a reconnect keeps you on the session you were viewing", async ({
  page,
}) => {
  // Open a session other than the bootstrap landing (the greeting).
  await openSidebar(page);
  await page.getByRole("button", { name: /^Explore the fold reducer/ }).click();
  await expect(
    page.getByText("It folds each driver event", { exact: false }),
  ).toBeVisible();

  // Drop the live socket and reconnect — the hub re-snapshots us onto the landing.
  await page.evaluate(() =>
    window.dispatchEvent(new Event("pantoken:test-disconnect")),
  );
  const reconnect = page.getByRole("button", { name: "Reconnect" });
  await expect(reconnect).toBeVisible();
  await reconnect.click();

  // Re-asserted onto the same session — not snapped to the greeting landing.
  await expect(
    page.getByText("It folds each driver event", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("Routes live in", { exact: false })).toHaveCount(
    0,
  );
});
