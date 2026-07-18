import { expect, type Page, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

const picker = (page: Page) => page.getByTestId("dir-picker");
const input = (page: Page) => page.getByLabel("Project directory path");
const draftBox = (page: Page) =>
  page.getByPlaceholder("Describe a task or ask a question…");

async function openPicker(page: Page, draft?: string): Promise<void> {
  await gotoFresh(page);
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();
  if (draft !== undefined) {
    await draftBox(page).fill(draft);
  }
  await page.getByTestId("draft-project-control").click();
  await expect(input(page)).toBeFocused();
}

test("project picker is a full-screen, touch-safe version of the desktop path picker", async ({
  page,
}) => {
  await openPicker(page);
  const box = await picker(page).boundingBox();
  const viewport = page.viewportSize()!;
  expect(box).not.toBeNull();
  expect(box!.width).toBe(viewport.width);
  expect(box!.height).toBe(viewport.height);
  await input(page).fill("/Users/timo/src/pi");
  const row = picker(page).locator(".directory").first();
  await expect(row).toBeVisible();
  expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(picker(page).locator("footer")).toBeHidden();
});

test("browser Back closes the picker and returns to the intact draft", async ({
  page,
}) => {
  await openPicker(page, "mobile draft");
  await page.goBack();
  await expect(picker(page)).toBeHidden();
  await expect(draftBox(page)).toHaveValue("mobile draft");
  // Issue #54: on a phone, closing the DirPicker focuses the project chip
  // (not the textarea) so the soft keyboard does not pop.
  await expect(page.getByTestId("draft-project-control")).toBeFocused();
});

test("visible Back closes the picker and consumes its nested history entry", async ({
  page,
}) => {
  await openPicker(page);
  await picker(page)
    .getByRole("button", { name: "Close project picker" })
    .first()
    .click();
  await expect(picker(page)).toBeHidden();
  // Reopening after a UI close must receive a fresh entry once the owned pop settles.
  await page.getByTestId("draft-project-control").click();
  await expect(input(page)).toBeFocused();
  await page.goBack();
  await expect(picker(page)).toBeHidden();
  await expect(draftBox(page)).toBeVisible();
});
