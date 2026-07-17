import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

// Issue #48: the left edges of the transcript prose, the stop button row
// (WorkingIndicator), and the composer must align exactly. The transcript's
// 760px reading measure is correct; the composer and WorkingIndicator used to
// resolve the global --maxw: 1000px (because the 760px override lived on
// .transcript-wrap, a sibling rather than an ancestor), so on wide viewports
// their centered inner columns drifted left of the transcript prose. The fix
// promotes --maxw / --maxw-wide to the shared .chat container so all three
// resolve the same measure, and splits the WorkingIndicator's padding and
// max-width across two elements (matching the Composer's .composer-wrap / .col
// structure) so the stop button's content-box aligns instead of sitting 44px
// inside the padded box. These assertions guard that alignment across a range
// of desktop widths — the stop button's position must no longer depend on the
// width of the window.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

for (const width of [1600, 1920, 2400]) {
  test(`transcript prose, stop button, and composer left edges align at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });

    // Drive a turn that stays running so the WorkingIndicator (stop button row)
    // is visible — it only renders while a turn is active.
    await drive(page, "streamhold");
    await expect(page.getByTestId("working-indicator")).toBeVisible();

    // Transcript prose left edge: .row.assistant .node-content > * is the rule
    // that caps prose at --maxw and centers it (max-width: var(--maxw);
    // margin-inline: auto). Its first child's left edge is the visible prose
    // left edge. The greeting fixture's first assistant turn starts with a text
    // paragraph, so .first() reliably captures the prose left edge.
    const prose = page
      .locator(".transcript-wrap .row.assistant .node-content > *")
      .first();
    await expect(prose).toBeVisible();

    const composer = page.getByTestId("composer-surface");
    const stop = page.getByTestId("stop-button");

    const proseBox = await prose.boundingBox();
    const composerBox = await composer.boundingBox();
    const stopBox = await stop.boundingBox();

    expect(proseBox).not.toBeNull();
    expect(composerBox).not.toBeNull();
    expect(stopBox).not.toBeNull();

    // AC.1: transcript prose vs composer surface.
    expect(Math.abs(proseBox!.x - composerBox!.x)).toBeLessThanOrEqual(1);
    // AC.2: transcript prose vs stop button (the visible content of the
    // working indicator row).
    expect(Math.abs(proseBox!.x - stopBox!.x)).toBeLessThanOrEqual(1);
    // Composer vs stop button (transitivity guard).
    expect(Math.abs(composerBox!.x - stopBox!.x)).toBeLessThanOrEqual(1);
  });
}
