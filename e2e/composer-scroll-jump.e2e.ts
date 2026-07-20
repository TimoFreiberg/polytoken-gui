import { expect, test } from "@playwright/test";
import { drive, gotoFresh, waitForSettledWorkBlocks } from "./helpers.js";

// Regression guard for #64: when the user types in the composer and the textarea grows
// (wraps to a new line), the transcript's last paragraph must not jump below the viewport.
// The pinned-to-bottom invariant must hold across composer-driven viewport resizes.
//
// FORCING THE BUG: like the drift tests (e2e/scroll-drift.e2e.ts), this spec disables
// `overflow-anchor` on the scroller to reproduce the bug in headless Chromium. Chrome's
// overflow-anchor normally compensates for viewport shrinks (adjusting scrollTop to keep
// the content pinned), masking the gap. But on iOS Safari — the real-world failure
// surface — overflow-anchor is unreliable, so the gap opens. Disabling it here simulates
// that environment. Without the fix, a single line-wrap creates ~68px of gap; with the
// fix, the scroller ResizeObserver re-asserts the bottom and the gap stays at 0.

/** Read the current gap (scrollHeight - scrollTop - clientHeight) of the scroller. */
function gapFn(scroller: import("@playwright/test").Locator) {
  return scroller.evaluate(
    (el) =>
      (el as HTMLElement).scrollHeight -
      (el as HTMLElement).scrollTop -
      (el as HTMLElement).clientHeight,
  );
}

/** Disable overflow-anchor so Chrome doesn't mask the gap on viewport shrink (simulates
 *  iOS Safari where overflow-anchor is unreliable — the real-world failure surface). */
async function disableOverflowAnchor(
  scroller: import("@playwright/test").Locator,
): Promise<void> {
  await scroller.evaluate((el) => {
    (el as HTMLElement).style.overflowAnchor = "none";
  });
}

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
  // Build a tall transcript so the scroller pins to the bottom and top != bottom.
  for (let i = 0; i < 4; i++) {
    await drive(page, "reply");
    await expect(
      page.getByText("That confirms it", { exact: false }).last(),
    ).toBeVisible();
  }
  await waitForSettledWorkBlocks(page, 5);
});

test("AC.1 — typing a line-wrap in the composer keeps the transcript pinned to the bottom", async ({
  page,
}) => {
  const scroller = page.locator(".scroller");
  const gap = () => gapFn(scroller);
  const textarea = page.locator(".composer-wrap textarea");

  // Start pinned at the bottom.
  await expect.poll(gap).toBeLessThan(5);

  // Disable overflow-anchor so Chrome doesn't mask the gap on viewport shrink.
  await disableOverflowAnchor(scroller);

  // Focus the composer and type enough text to force a line wrap. The textarea starts
  // at rows=1; a single long line wraps, growing the composer by one line (~24px) and
  // shrinking the scroller's clientHeight via flex reflow.
  await textarea.click();
  await textarea.fill(
    "This is a long line of text that will wrap to multiple lines when typed into the composer textarea, causing it to grow and shrink the transcript viewport",
  );

  // The gap must remain under 5px — the last paragraph did not jump below the viewport.
  // Without the fix, the gap opens to ~68px (the composer grew, shrinking clientHeight,
  // and overflow-anchor is off so scrollTop stays put).
  await expect.poll(gap).toBeLessThan(5);
});

test("AC.2 — grow→shrink→grow cycle keeps the transcript pinned throughout", async ({
  page,
}) => {
  const scroller = page.locator(".scroller");
  const gap = () => gapFn(scroller);
  const textarea = page.locator(".composer-wrap textarea");

  // Start pinned at the bottom.
  await expect.poll(gap).toBeLessThan(5);

  // Disable overflow-anchor so Chrome doesn't mask the gap on viewport shrink.
  await disableOverflowAnchor(scroller);

  // Grow: type wrapping text.
  await textarea.click();
  await textarea.fill(
    "This is a long line of text that will wrap to multiple lines when typed into the composer textarea, causing it to grow and shrink the transcript viewport",
  );
  await expect.poll(gap).toBeLessThan(5);

  // Shrink: delete the text (composer shrinks back to one row).
  await textarea.fill("");
  await expect.poll(gap).toBeLessThan(5);

  // Grow again: type wrapping text once more.
  await textarea.fill(
    "Another long line of text that wraps to multiple lines, growing the composer again after the shrink",
  );
  await expect.poll(gap).toBeLessThan(5);
});
