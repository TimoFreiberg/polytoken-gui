import { expect, test } from "@playwright/test";
import {
  drive,
  expandWork,
  gotoFresh,
  openSettings,
  waitForSettledWorkBlocks,
} from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

// Helper: locate the CollapseFooter button inside a container. Uses the
// .collapse-footer class rather than getByRole("button", { name: "Collapse" })
// because the ToolCard's out-bar also has a "Collapse" button — role+name
// matching would resolve to both and trip strict mode.
function footerIn(locator: ReturnType<import("@playwright/test").Locator["filter"]>) {
  return locator.locator(".collapse-footer");
}

// AC.1 — An expanded ToolCard whose body exceeds ~50% of the viewport height shows
// a collapse chevron at its bottom edge. Clicking it collapses the card.
test("tool card shows bottom collapse when tall", async ({ page }) => {
  await drive(page, "longoutput");
  await waitForSettledWorkBlocks(page, 2);
  await expandWork(page, "last");

  // Open the tool card.
  const head = page
    .getByTestId("work-body")
    .last()
    .locator(":scope > .tool > .head");
  await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "true");

  const tool = page.getByTestId("work-body").last().locator(":scope > .tool");
  const body = tool.locator(":scope > .body");

  // The 40-line output is capped at 320px; expand it to drop the cap so the body
  // grows past 50% of the viewport.
  const expandBtn = tool
    .locator(".out-bar")
    .getByRole("button", { name: "Expand", exact: true });
  await expect(expandBtn).toBeVisible();
  await expandBtn.click();

  // The CollapseFooter chevron should now be visible (body is tall).
  const footer = body.locator(".collapse-footer");
  await expect(footer).toBeVisible();
  await expect(footer).toHaveAttribute("aria-expanded", "true");
  await expect(footer).not.toHaveAttribute("aria-hidden", "true");

  // Click it → card collapses.
  await footer.click();
  await expect(head).toHaveAttribute("aria-expanded", "false");
});

// AC.2 — An expanded ThinkingBlock whose body exceeds ~50% of the viewport height
// shows a collapse chevron at its bottom edge. Clicking it collapses the block.
test("thinking block shows bottom collapse when tall", async ({ page }) => {
  // Turn the (default-on) hide-thinking toggle off via Settings.
  await openSettings(page, "appearance");
  const toggle = page.getByTestId("hide-thinking");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");

  await drive(page, "longthinking");
  await waitForSettledWorkBlocks(page, 2);
  await expandWork(page, "last");

  // Open the thinking block.
  const think = page.locator(".think .head");
  await think.click();
  await expect(think).toHaveAttribute("aria-expanded", "true");

  // The CollapseFooter chevron should be visible (thinking text is long).
  const body = page.locator(".think > .body");
  const footer = body.locator(".collapse-footer");
  await expect(footer).toBeVisible();

  // Click it → thinking block collapses.
  await footer.click();
  await expect(think).toHaveAttribute("aria-expanded", "false");
});

// AC.3 — An expanded "Worked for Ns" block whose body exceeds ~50% of the viewport
// height shows a collapse chevron at its bottom edge. Clicking it collapses the block.
test("worked-for-Ns shows bottom collapse when tall", async ({ page }) => {
  // Drive longoutput — the expanded work body with the tool card open + output
  // expanded is tall enough to exceed 50% viewport.
  await drive(page, "longoutput");
  await waitForSettledWorkBlocks(page, 2);
  await expandWork(page, "last");

  // Open the tool card and expand its output so the work-body grows tall.
  const head = page
    .getByTestId("work-body")
    .last()
    .locator(":scope > .tool > .head");
  await head.click();
  const expandBtn = page
    .getByTestId("work-body")
    .last()
    .locator(".out-bar")
    .getByRole("button", { name: "Expand", exact: true });
  await expect(expandBtn).toBeVisible();
  await expandBtn.click();

  // The work-body's CollapseFooter chevron should be visible. The work-body has
  // its own footer as a DIRECT child — scope to direct children so we don't pick
  // up the nested tool card's footer.
  const workBody = page.getByTestId("work-body").last();
  const footer = workBody.locator(":scope > .collapse-footer");
  await expect(footer).toBeVisible();

  // Click the work-body footer → work block collapses.
  await footer.click();
  const workToggle = page.getByTestId("work-toggle").last();
  await expect(workToggle).toHaveAttribute("aria-expanded", "false");
});

// AC.4 — Expanded elements shorter than ~50% of the viewport height do NOT show a
// collapse chevron.
test("short content shows no footer", async ({ page }) => {
  await drive(page, "reply");
  await waitForSettledWorkBlocks(page, 2);
  await expandWork(page, "last");

  // Open the tool card — its body is short (a short read result).
  const head = page
    .getByTestId("work-body")
    .last()
    .locator(":scope > .tool > .head");
  await head.click();

  const body = page
    .getByTestId("work-body")
    .last()
    .locator(":scope > .tool > .body");
  const footer = body.locator(".collapse-footer");
  // The footer is always in the DOM but hidden when content is short.
  await expect(footer).toHaveAttribute("aria-hidden", "true");
});

// AC.5 — The ThinkingBlock's header is no longer position: sticky.
test("thinking header is not sticky", async ({ page }) => {
  await openSettings(page, "appearance");
  const toggle = page.getByTestId("hide-thinking");
  await toggle.click();
  await page.keyboard.press("Escape");

  await drive(page, "longthinking");
  await waitForSettledWorkBlocks(page, 2);
  await expandWork(page, "last");

  const think = page.locator(".think .head");
  await think.click();
  await expect(think).toHaveAttribute("aria-expanded", "true");

  await expect
    .poll(() => think.evaluate((el) => getComputedStyle(el).position))
    .not.toBe("sticky");
});

// AC.6 — The collapse footer chevron is keyboard-focusable and has an aria-label
// naming the action ("Collapse").
test("footer is keyboard-accessible", async ({ page }) => {
  await drive(page, "longoutput");
  await waitForSettledWorkBlocks(page, 2);
  await expandWork(page, "last");

  const head = page
    .getByTestId("work-body")
    .last()
    .locator(":scope > .tool > .head");
  await head.click();
  const expandBtn = page
    .getByTestId("work-body")
    .last()
    .locator(".out-bar")
    .getByRole("button", { name: "Expand", exact: true });
  await expandBtn.click();

  const body = page
    .getByTestId("work-body")
    .last()
    .locator(":scope > .tool > .body");
  const footer = body.locator(".collapse-footer");
  await expect(footer).toBeVisible();
  await expect(footer).toHaveAttribute("aria-label", "Collapse");

  // Focus the footer and press Enter to collapse.
  await footer.focus();
  await expect(footer).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(head).toHaveAttribute("aria-expanded", "false");
});
