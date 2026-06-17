import { expect, test } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
  // gotoFresh waits for the greeting's last text, but the greeting fires one more
  // runCompleted ~60ms later carrying the DEFAULT model config. These tests assert
  // config survives a switch, so let that trailing snapshot land first or it can
  // clobber the selection mid-test (the mock's only competing config source).
  await page.waitForTimeout(300);
});

test("the model picker lists models and switches the active one", async ({
  page,
}) => {
  // The badge shows the mock's default model as a friendly label (raw id in tooltip).
  const modelBadge = page
    .locator(".mp .badge")
    .filter({ hasText: "Claude Opus 4.8" });
  await expect(modelBadge).toBeVisible();

  await modelBadge.click();

  // The dropdown groups available models by provider.
  await expect(page.getByText("DeepSeek V4 Flash")).toBeVisible();
  await page.getByText("DeepSeek V4 Flash").click();

  // The badge reflects the switched-to model (server round-trip → folded config).
  await expect(
    page.locator(".mp .badge").filter({ hasText: "DeepSeek V4 Flash" }),
  ).toBeVisible();
});

test("the thinking picker switches the level", async ({ page }) => {
  await page.locator(".mp .badge").filter({ hasText: "medium" }).click();
  await page.locator(".mp .item").filter({ hasText: "high" }).click();
  await expect(
    page.locator(".mp .badge").filter({ hasText: "high" }),
  ).toBeVisible();
});

test("the model menu has a search that filters the list", async ({ page }) => {
  await page
    .locator(".mp .badge")
    .filter({ hasText: "Claude Opus 4.8" })
    .click();
  const panel = page.locator(".mp .panel");
  await expect(panel).toBeVisible();
  const search = panel.getByPlaceholder("Search models…");

  await search.fill("deep");
  await expect(panel.getByText("DeepSeek V4 Flash")).toBeVisible();
  await expect(panel.getByText("Claude Opus 4.8")).toHaveCount(0);
  await expect(panel.getByText("GPT-5")).toHaveCount(0);

  // no-match state
  await search.fill("zzzz");
  await expect(panel.getByText("No models match")).toBeVisible();
});
