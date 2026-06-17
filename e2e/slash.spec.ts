import { expect, type Page, test } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

const ta = (page: Page) => page.locator(".composer-wrap textarea");
const row = (page: Page, name: string) =>
  page.getByTestId("slash-menu").locator(`[data-cmd="${name}"]`);

test("a leading slash opens the command menu", async ({ page }) => {
  await ta(page).fill("/");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  // All three command sources (from MOCK_COMMANDS) are offered.
  await expect(row(page, "review")).toBeVisible();
  await expect(row(page, "plan")).toBeVisible();
  await expect(row(page, "skill:debug")).toBeVisible();
});

test("typing filters the menu to matching commands", async ({ page }) => {
  await ta(page).fill("/re");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  await expect(row(page, "review")).toBeVisible();
  // "plan" doesn't contain "re", so it's filtered out.
  await expect(row(page, "plan")).toHaveCount(0);
});

test("Enter accepts the highlighted command into the draft", async ({
  page,
}) => {
  const box = ta(page);
  await box.fill("/re");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  await box.press("Enter");
  // The bare token is replaced with `/name ` (trailing space) and the menu closes —
  // no message is sent, so the user can add arguments.
  await expect(box).toHaveValue("/review ");
  await expect(page.getByTestId("slash-menu")).toHaveCount(0);
});

test("clicking a command inserts it", async ({ page }) => {
  const box = ta(page);
  await box.fill("/sk");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  await row(page, "skill:journal").click();
  await expect(box).toHaveValue("/skill:journal ");
});

test("Escape dismisses the menu without changing the draft", async ({
  page,
}) => {
  const box = ta(page);
  await box.fill("/re");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  await box.press("Escape");
  await expect(page.getByTestId("slash-menu")).toHaveCount(0);
  await expect(box).toHaveValue("/re");
});
