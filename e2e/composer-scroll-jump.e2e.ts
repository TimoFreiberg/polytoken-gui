import { expect, test } from "@playwright/test";
import { drive, gotoFresh, waitForSettledWorkBlocks, wheelUp } from "./helpers.js";

// Regression guard for #64: when the user types in the composer and the textarea grows
// (wraps to a new line), the transcript's last paragraph must not jump below the viewport.
// The pinned-to-bottom invariant must hold across composer-driven viewport resizes.
//
// The scroller has `overflow-anchor: none` globally (added in #86), so Chrome no longer
// masks the gap on viewport shrink — simulating the iOS Safari / WKWebView failure
// surface where overflow-anchor is unreliable. Without the fix, a single line-wrap
// creates ~68px of gap; with the fix, the scroller ResizeObserver re-asserts the bottom
// and the gap stays at 0.

/** Read the current gap (scrollHeight - scrollTop - clientHeight) of the scroller. */
function gapFn(scroller: import("@playwright/test").Locator) {
  return scroller.evaluate(
    (el) =>
      (el as HTMLElement).scrollHeight -
      (el as HTMLElement).scrollTop -
      (el as HTMLElement).clientHeight,
  );
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

test("AC.3 — proactive re-assert fired: composerResizeN incremented after typing a wrapping line", async ({
  page,
}) => {
  const scroller = page.locator(".scroller");
  const textarea = page.locator(".composer-wrap textarea");

  await expect.poll(() => gapFn(scroller)).toBeLessThan(5);

  // Snapshot the counter before (may be > 0 from prior setup keystrokes).
  const before = Number((await scroller.getAttribute("data-composer-resize-n")) ?? 0);

  await textarea.click();
  await textarea.fill(
    "This is a long line of text that will wrap to multiple lines when typed into the composer textarea, causing it to grow and shrink the transcript viewport",
  );

  // The proactive path sets dataset.composerResizeN; the async viewportObserver
  // does NOT. So if the attribute incremented, the proactive effect ran.
  await expect
    .poll(async () => Number((await scroller.getAttribute("data-composer-resize-n")) ?? 0))
    .toBeGreaterThan(before);
  // And the gap stayed closed (the re-assert did its job).
  await expect.poll(() => gapFn(scroller)).toBeLessThan(5);
});

test("AC.4 — a reader scrolled up is not yanked down when the composer grows", async ({
  page,
}) => {
  const scroller = page.locator(".scroller");
  const textarea = page.locator(".composer-wrap textarea");

  // Start pinned at the bottom.
  await expect.poll(() => gapFn(scroller)).toBeLessThan(5);

  // Scroll up — a reader reading scrollback. Via real wheel input so the
  // input-gated pin registers it as a user action and un-pins.
  await wheelUp(page, 400);
  // Confirm we're genuinely scrolled up (pinned should be false now).
  await expect.poll(() => gapFn(scroller)).toBeGreaterThan(80);

  const topBefore = await scroller.evaluate((el) => (el as HTMLElement).scrollTop);
  // Snapshot the proactive tick before typing — it must NOT increment here
  // (the effect bails on `!pinned`). This directly tests the effect's guard,
  // which scrollTop alone cannot (applySettle has its own redundant `!pinned`
  // bail that would also prevent a yank).
  const resizeNBefore = await scroller.getAttribute("data-composer-resize-n");

  // Type a wrapping line — autosize bumps composerResizeN, the proactive
  // effect fires but must bail (pinned === false). scrollTop must not jump.
  await textarea.click();
  await textarea.fill(
    "This is a long line of text that will wrap to multiple lines when typed into the composer textarea, causing it to grow and shrink the transcript viewport",
  );

  const topAfter = await scroller.evaluate((el) => (el as HTMLElement).scrollTop);
  // The reader was NOT yanked to the bottom — scrollTop barely moved (the
  // viewport shrink may nudge it a few px, but not hundreds).
  expect(Math.abs(topAfter - topBefore)).toBeLessThan(20);
  // The proactive effect's `pinned` guard held — it did NOT set the tick
  // attribute (if it had, the guard was removed and this would fail).
  const resizeNAfter = await scroller.getAttribute("data-composer-resize-n");
  expect(resizeNAfter).toBe(resizeNBefore);
});

test("AC.5 — a non-wrapping keystroke does not cause the transcript to jump", async ({
  page,
}) => {
  const scroller = page.locator(".scroller");
  const gap = () => gapFn(scroller);
  const textarea = page.locator(".composer-wrap textarea");
  const box = page.locator('[data-testid="composer-box"]');

  // Start pinned at the bottom.
  await expect.poll(gap).toBeLessThan(5);

  // Without the testForHeightReduction optimization, the height="auto" reset on every
  // keystroke would cause a transient layout invalidation → jitter on WKWebView.
  // (overflow-anchor: none is set globally on .scroller — no per-test override needed.)
  // Snapshot the reset counter before (may be > 0 from prior setup keystrokes).
  const resetBefore = Number((await box.getAttribute("data-autosize-reset-n")) ?? 0);

  // Type a single character — the composer stays at one row (no line wrap),
  // so the height doesn't change. The testForHeightReduction optimization
  // skips the height="auto" reset (text grew → no reset needed), avoiding
  // the transient layout invalidation that causes jitter on WKWebView.
  await textarea.click();
  await textarea.fill("a");

  // The reset path did NOT run — the optimization skipped it (text grew).
  // Without the optimization, the reset would have run and incremented this.
  const resetAfter = Number((await box.getAttribute("data-autosize-reset-n")) ?? 0);
  expect(resetAfter).toBe(resetBefore);
  // And the gap stayed under 5px — the transcript did not jump.
  await expect.poll(gap).toBeLessThan(5);
});
