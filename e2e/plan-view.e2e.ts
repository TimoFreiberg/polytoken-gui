import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

// The PlanView overlay surfaces the daemon's active_plan (the plan facet's
// structured plan document) as a modal rendering of the plan markdown. Triggered
// by a StatusHeader button that appears only when activePlan is non-empty.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("the plan button appears, opens the overlay, and Escape closes it", async ({
  page,
}) => {
  // Before driving `planview`: no activePlan → no Plan button (AC.4).
  await expect(page.getByTestId("plan-view-toggle")).toHaveCount(0);

  // Drive the planview fixture → a snapshot with activePlan lands.
  await drive(page, "planview");

  // The Plan button appears in the StatusHeader (AC.1).
  const planBtn = page.getByTestId("plan-view-toggle");
  await expect(planBtn).toBeVisible();

  // Click it → the PlanView modal opens with the plan markdown rendered (AC.2).
  await planBtn.click();
  const modal = page.getByTestId("plan-view");
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("Wire up the plan overlay");

  // Escape closes the modal (AC.3).
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
});

test("⌘P toggles the plan view overlay", async ({ page }) => {
  await drive(page, "planview");
  await expect(page.getByTestId("plan-view-toggle")).toBeVisible();

  // ⌘P opens the overlay.
  await page.keyboard.press("Meta+p");
  await expect(page.getByTestId("plan-view")).toBeVisible();

  // ⌘P again closes it.
  await page.keyboard.press("Meta+p");
  await expect(page.getByTestId("plan-view")).toHaveCount(0);
});

test("the overlay renders the full plan markdown", async ({ page }) => {
  await drive(page, "planview");
  await page.getByTestId("plan-view-toggle").click();
  const modal = page.getByTestId("plan-view");
  await expect(modal).toBeVisible();

  // The plan's heading + body render (the Markdown.svelte path).
  const body = page.getByTestId("plan-view-body");
  await expect(body).toContainText("Wire up the plan overlay");
  await expect(body).toContainText("SessionSnapshot protocol");
  await expect(body).toContainText("event-map");
  await expect(body).toContainText("read-only");

  // Escape closes.
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
});
