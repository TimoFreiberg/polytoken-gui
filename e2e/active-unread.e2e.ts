import { expect, test } from "@playwright/test";
import {
  drive,
  gotoFresh,
  openSidebar,
  waitForSettledWorkBlocks,
  wheelUp,
} from "./helpers.js";

// The active (focused) session is normally "read", but should flag unread when the agent
// appends content below the fold while you're scrolled up reading scrollback — the same signal
// as the "New messages ↓" pill, reflected in the sidebar row. Cleared on scroll-to-bottom.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("scrolling up while the agent appends content flags the active session unread", async ({
  page,
}) => {
  // Build a transcript taller than the fold so top and bottom differ.
  for (let i = 0; i < 3; i++) {
    await drive(page, "reply");
    await expect(
      page.getByText("That confirms it", { exact: false }).last(),
    ).toBeVisible();
  }
  await waitForSettledWorkBlocks(page, 4);

  await openSidebar(page);
  const status = page
    .getByTestId("sidebar")
    .locator(".row-wrap")
    .filter({ hasText: "Wire up the WebSocket" })
    .getByTestId("session-status");
  // The active session starts read.
  await expect(status).toHaveAttribute("data-state", "read");

  // Scroll up so we're no longer pinned to the bottom — via real wheel input
  // (not programmatic scrollTop) so the input-gated pin registers it as user
  // action and un-pins.
  const scroller = page.locator(".scroller");
  const gap = () =>
    scroller.evaluate(
      (el) =>
        (el as HTMLElement).scrollHeight -
        (el as HTMLElement).scrollTop -
        (el as HTMLElement).clientHeight,
    );
  await wheelUp(page, 600);
  await expect.poll(gap).toBeGreaterThan(80); // genuinely scrolled up off the bottom

  // The agent appends a new turn while we're scrolled up — it lands below the viewport.
  await drive(page, "reply");

  // The "New messages ↓" pill appears AND the active session's row flags unread.
  await expect(page.getByTestId("new-messages-pill")).toBeVisible();
  await expect(status).toHaveAttribute("data-state", "unread");

  // Jumping to the bottom (you've now seen it) clears both.
  await page.getByTestId("new-messages-pill").click();
  await expect(page.getByTestId("new-messages-pill")).toHaveCount(0);
  await expect(status).toHaveAttribute("data-state", "read");
});
