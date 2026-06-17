import { expect, type Page, test } from "@playwright/test";
import { drive, gotoFresh, openSidebar } from "./helpers.js";

// The mock's background session (older-session) that the `bgrun` script drives
// through a running → done turn; the active one is the greeting session.
const BG = "Explore the fold reducer";
const ACTIVE = "Wire up the WebSocket bridge";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

/** The status-indicator span on a given session's sidebar row. */
function statusOf(page: Page, title: string) {
  return page
    .getByTestId("sidebar")
    .locator(".row", { hasText: title })
    .getByTestId("session-status");
}

test("a background session shows running, then unread, then clears on open", async ({
  page,
}) => {
  await openSidebar(page);

  // Baseline: the session you're viewing is read, and the idle background one too.
  await expect(statusOf(page, ACTIVE)).toHaveAttribute("data-state", "read");
  await expect(statusOf(page, BG)).toHaveAttribute("data-state", "read");

  // Drive a *background* turn — its row shows the running indicator while the
  // active session stays read (the turn never touches the focused transcript).
  await drive(page, "bgrun");
  await expect(statusOf(page, BG)).toHaveAttribute("data-state", "running");
  await expect(statusOf(page, ACTIVE)).toHaveAttribute("data-state", "read");

  // When the background turn finishes it becomes unread (new since last viewed).
  await expect(statusOf(page, BG)).toHaveAttribute("data-state", "unread");

  // Opening it marks it read again.
  await page.getByTestId("sidebar").locator(".row", { hasText: BG }).click();
  await openSidebar(page); // the mobile drawer closes on navigate; desktop is a no-op
  await expect(statusOf(page, BG)).toHaveAttribute("data-state", "read");
});
