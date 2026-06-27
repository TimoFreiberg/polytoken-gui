import { expect, test } from "@playwright/test";
import { drive, gotoFresh, waitForSettledWorkBlocks } from "./helpers.js";

// Happy-path smoke only — NOT a regression guard for the bug. The failure it targets (a
// snapToBottom chase frame landing short because scrollHeight grew under it, firing a
// scroll event at gap ≥ 80) can't be staged in headless Chromium: Chrome's overflow-anchor
// keeps gap near 0 on growth, so this spec PASSES against the pre-fix `pinned = gap < 80`
// rule too (empirically verified). The pin DECISION is guarded by scroll-follow.test.ts;
// this spec only catches gross wiring breakage (nextPinned throwing, `pinned` never
// updating, the pill testid disappearing). Kept because that thin signal is cheap.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("sending a prompt keeps the transcript following the stream to the bottom", async ({
  page,
}) => {
  const scroller = page.locator(".scroller");
  const gap = () =>
    scroller.evaluate(
      (el) =>
        (el as HTMLElement).scrollHeight -
        (el as HTMLElement).scrollTop -
        (el as HTMLElement).clientHeight,
    );

  // Build a transcript tall enough that top and bottom differ.
  for (let i = 0; i < 3; i++) {
    await drive(page, "reply");
    await expect(
      page.getByText("That confirms it", { exact: false }).last(),
    ).toBeVisible();
  }
  await waitForSettledWorkBlocks(page, 4);
  await expect.poll(gap).toBeLessThan(80); // pinned at the live tail

  // Send a fresh prompt and let its turn stream + settle. The viewport must follow the
  // new output to the bottom — the just-sent bubble and its reply in view, not left below
  // the fold behind a "New messages ↓" pill.
  await drive(page, "reply");
  await waitForSettledWorkBlocks(page, 5);
  await expect.poll(gap).toBeLessThan(80);
  await expect(page.getByTestId("new-messages-pill")).toHaveCount(0);
});
