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

test("the go-to-path input jumps to a typed directory", async ({ page }) => {
  await openDraft(page);
  await projectChip(page).click();
  await expect(picker(page)).toBeVisible();

  // The ✎ button swaps the breadcrumb for a path box — the escape hatch for dirs that
  // are tedious to click to. Type an absolute path and Enter navigates there.
  await picker(page).locator(".edit-path").click();
  const input = picker(page).getByLabel("Go to path");
  await expect(input).toBeFocused();
  await input.fill("/Users/timo/src/pi");
  await input.press("Enter");

  await expect(picker(page).locator(".bc")).toContainText("pi");
  await expect(
    picker(page).locator(".row[data-i] .name").filter({ hasText: "examples" }),
  ).toBeVisible();

  // And the jumped-to folder can be used.
  await picker(page).locator(".use").click();
  await expect(picker(page)).toBeHidden();
  await expect(projectChip(page)).toContainText("pi");
});

test("Escape in the path box cancels the edit without closing the browser", async ({
  page,
}) => {
  await openDraft(page);
  await projectChip(page).click();
  await expect(picker(page)).toBeVisible();

  await picker(page).locator(".edit-path").click();
  const input = picker(page).getByLabel("Go to path");
  await expect(input).toBeVisible();
  await input.press("Escape");

  // The path box closes, the breadcrumb returns, and the picker stays open.
  await expect(input).toBeHidden();
  await expect(picker(page).locator(".bc .crumb").first()).toBeVisible();
  await expect(picker(page)).toBeVisible();
});
