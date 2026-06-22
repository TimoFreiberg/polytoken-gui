import { expect, type Page, test } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

// Control (not Meta) — CI runs Chromium on Linux and the handler accepts metaKey||ctrlKey.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

const box = (page: Page) => page.getByTestId("transcript-search");
const count = (page: Page) => page.getByTestId("find-count");
const findInput = (page: Page) =>
  box(page).getByPlaceholder("Find in transcript");

function currentHighlighted(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      typeof CSS !== "undefined" &&
      "highlights" in CSS &&
      CSS.highlights.has("pilot-find-current"),
  );
}

test("⌘F opens the find box and focuses it", async ({ page }) => {
  await expect(box(page)).toBeHidden();
  await page.keyboard.press("Control+f");
  await expect(box(page)).toBeVisible();
  await expect(findInput(page)).toBeFocused();
});

test("find-as-you-type counts matches, highlights, and steps next/prev", async ({
  page,
}) => {
  await page.keyboard.press("Control+f");
  // "health" appears in the user prompt and the final assistant line (≥2 visible).
  await findInput(page).fill("health");

  await expect(count(page)).toHaveText(/^1\/\d+$/);
  await expect.poll(() => currentHighlighted(page)).toBe(true);

  // Next / prev cycle the current index (Enter == next button).
  await page.getByRole("button", { name: "Next match" }).click();
  await expect(count(page)).toHaveText(/^2\/\d+$/);
  await page.getByRole("button", { name: "Previous match" }).click();
  await expect(count(page)).toHaveText(/^1\/\d+$/);

  // Enter also advances.
  await findInput(page).press("Enter");
  await expect(count(page)).toHaveText(/^2\/\d+$/);
});

test("a query with no matches shows 0/0 and no current highlight", async ({
  page,
}) => {
  await page.keyboard.press("Control+f");
  await findInput(page).fill("zzznotinthetranscript");
  await expect(count(page)).toHaveText("0/0");
  await expect.poll(() => currentHighlighted(page)).toBe(false);
});

test("Esc closes the box and clears highlights", async ({ page }) => {
  await page.keyboard.press("Control+f");
  await findInput(page).fill("health");
  await expect(count(page)).toHaveText(/^1\/\d+$/);
  await expect.poll(() => currentHighlighted(page)).toBe(true);

  await findInput(page).press("Escape");
  await expect(box(page)).toBeHidden();
  await expect.poll(() => currentHighlighted(page)).toBe(false);
});

test("⌘F does nothing while drafting a new session (no transcript)", async ({
  page,
}) => {
  await page.keyboard.press("Control+n"); // open a new-session draft
  await expect(
    page.getByPlaceholder("Describe a task or ask a question…"),
  ).toBeVisible();
  await page.keyboard.press("Control+f");
  await expect(box(page)).toBeHidden();
});
