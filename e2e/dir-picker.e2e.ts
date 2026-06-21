import { expect, type Page, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

const picker = (page: Page) => page.getByTestId("dir-picker");
const projectChip = (page: Page) => page.locator(".chips .chip").first();
const draftBox = (page: Page) =>
  page.getByPlaceholder("Describe a task or ask a question…");

async function openDraft(page: Page): Promise<void> {
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();
  await expect(draftBox(page)).toBeVisible();
}

test("the project chip browses the server's directories and picks one", async ({
  page,
}) => {
  await openDraft(page);
  await projectChip(page).click();
  await expect(picker(page)).toBeVisible();

  // Normalize to $HOME so assertions don't depend on the draft's initial cwd (the mock
  // serves a fixture tree under home — child names are stable regardless of the actual
  // home path the suite runs under).
  await picker(page).locator(".home-btn").click();
  const rows = picker(page).locator(".row[data-i] .name");
  await expect(rows.filter({ hasText: "src" })).toBeVisible();

  // Descend into src; its children include the project dirs.
  await picker(page).locator(".row[data-i]", { hasText: "src" }).click();
  await expect(rows.filter({ hasText: "pilot" })).toBeVisible();

  // "Use this folder" commits the dir we're standing in and closes the picker.
  await picker(page).locator(".use").click();
  await expect(picker(page)).toBeHidden();
  await expect(projectChip(page)).toContainText("src");
  await expect(page.getByTestId("new-session")).toContainText("/src");
});

test("Escape closes the directory browser without abandoning the draft", async ({
  page,
}) => {
  await openDraft(page);
  await draftBox(page).fill("keep me");

  await projectChip(page).click();
  await expect(picker(page)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(picker(page)).toBeHidden();
  // The draft (and its in-progress prompt) survives — Escape only dismisses the picker.
  await expect(draftBox(page)).toHaveValue("keep me");
});

test("a recent project is a one-tap pick from the browser", async ({
  page,
}) => {
  await openDraft(page);
  await projectChip(page).click();
  await expect(picker(page)).toBeVisible();

  // `scratch` is a fixture session's cwd, so it surfaces as a recent shortcut; tapping it
  // picks that directory outright (no navigation).
  await picker(page).locator(".recent-chip", { hasText: "scratch" }).click();
  await expect(picker(page)).toBeHidden();
  await expect(projectChip(page)).toContainText("scratch");
});
