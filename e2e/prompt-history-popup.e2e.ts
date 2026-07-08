import { expect, test } from "@playwright/test";
import { gotoFresh, drive } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("Ctrl+R opens prompt history popup and fills the composer on Enter", async ({
  page,
}) => {
  // Send a few prompts so there's history to recall.
  const composer = page.getByPlaceholder("Message pantoken…");
  for (let i = 0; i < 3; i++) {
    await drive(page, "reply");
    await expect(
      page.getByText("That confirms it", { exact: false }).last(),
    ).toBeVisible();
  }

  // Focus the composer and press Ctrl+R.
  await composer.focus();
  await composer.press("Control+r");

  // The popup should be visible with recent prompts.
  const menu = page.getByTestId("prompt-history-menu");
  await expect(menu).toBeVisible();
  // At least one option (the exact count depends on how many unique prompts were sent).
  const optCount = await menu.getByRole("option").count();
  expect(optCount).toBeGreaterThan(0);

  // Arrow down to the next entry, Enter fills the composer.
  await menu.press("ArrowDown");
  await menu.press("Enter");
  await expect(menu).toHaveCount(0);
  // The composer should now have text (the selected prompt).
  await expect(composer).not.toHaveValue("");
});

test("Escape closes the prompt history popup without filling", async ({ page }) => {
  const composer = page.getByPlaceholder("Message pantoken…");
  await drive(page, "reply");
  await expect(
    page.getByText("That confirms it", { exact: false }),
  ).toBeVisible();

  await composer.focus();
  await composer.press("Control+r");
  const menu = page.getByTestId("prompt-history-menu");
  await expect(menu).toBeVisible();

  await menu.press("Escape");
  await expect(menu).toHaveCount(0);
  // Composer should still be empty (no prompt was selected).
  await expect(composer).toHaveValue("");
});
