import { expect, type Page, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

const picker = (page: Page) => page.getByTestId("dir-picker");
const filterInput = (page: Page) => picker(page).locator(".filter-input");
const projectChip = (page: Page) => page.getByTestId("draft-project-control");
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
  await expect(rows.filter({ hasText: "pantoken" })).toBeVisible();

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
  // The picker auto-focuses its always-visible filter input.
  await expect(filterInput(page)).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(picker(page)).toBeHidden();
  // The draft (and its in-progress prompt) survives — Escape only dismisses the picker.
  await expect(draftBox(page)).toHaveValue("keep me");
});

test("⌥P opens the project picker from the draft composer", async ({
  page,
}) => {
  await openDraft(page);
  await draftBox(page).focus();
  await expect(picker(page)).toBeHidden();

  // ⌥P (KeyP, layout-independent) opens the picker, mirroring ⌥W for the worktree chip.
  await draftBox(page).press("Alt+p");
  await expect(picker(page)).toBeVisible();
  // Focus lands in the picker's always-visible filter input (autofocus), ready to navigate.
  await expect(filterInput(page)).toBeFocused();
  // The hotkey is suppressed in the textarea — no stray character leaks into the draft.
  await expect(draftBox(page)).toHaveValue("");

  // Escape closes it again, leaving the draft alive.
  await page.keyboard.press("Escape");
  await expect(picker(page)).toBeHidden();
  await expect(draftBox(page)).toBeVisible();
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

  // The filter input is always visible. Start typing a path with / to enter path
  // mode, then Enter navigates there directly (no separate edit button).
  // Use the stable .filter-input class — the aria-label changes between
  // "Filter subdirectories" and "Go to path" as the user types, which would
  // invalidate a `getByLabel` locator mid-test.
  await filterInput(page).fill("/Users/timo/src/pi");
  // In path mode the input's label changes.
  await expect(picker(page).getByLabel("Go to path")).toBeVisible();
  await filterInput(page).press("Enter");

  await expect(picker(page).locator(".bc")).toContainText("pi");
  await expect(
    picker(page).locator(".row[data-i] .name").filter({ hasText: "examples" }),
  ).toBeVisible();

  // And the jumped-to folder can be used.
  await picker(page).locator(".use").click();
  await expect(picker(page)).toBeHidden();
  await expect(projectChip(page)).toContainText("pi");
});

test("typing filters subdirectories by fuzzy match", async ({ page }) => {
  await openDraft(page);
  await projectChip(page).click();
  await expect(picker(page)).toBeVisible();

  // Navigate to home so the entry list is stable.
  await picker(page).locator(".home-btn").click();
  // Wait for the listing to settle (the "src" row is visible).
  await expect(
    picker(page).locator(".row[data-i] .name").filter({ hasText: "src" }),
  ).toBeVisible();

  // Type a partial match — "sr" should match "src" by subsequence (s…r).
  await filterInput(page).fill("sr");

  const rows = picker(page).locator(".row[data-i] .name");
  // "src" should still be visible (fuzzy subsequence match).
  await expect(rows.filter({ hasText: "src" })).toBeVisible();
  // Only "src" remains (no ".." row); the other entries are hidden.
  await expect(rows).toHaveCount(1);
  // Documents (which doesn't match "sr") should be gone.
  await expect(rows.filter({ hasText: "Documents" })).toBeHidden();

  // Clear the filter (Escape) — all entries reappear.
  await filterInput(page).press("Escape");
  await expect(filterInput(page)).toHaveValue("");
  await expect(rows).not.toHaveCount(1); // more entries now
});

test("Enter with an empty filter uses the directory you're standing in", async ({
  page,
}) => {
  await openDraft(page);
  await projectChip(page).click();
  await expect(picker(page)).toBeVisible();

  await picker(page).locator(".home-btn").click();
  const rows = picker(page).locator(".row[data-i] .name");
  await expect(rows.filter({ hasText: "src" })).toBeVisible();

  // Descend into src so we're standing in a concrete dir, then commit it with Enter
  // (no filter text) instead of clicking "Use this folder".
  await picker(page).locator(".row[data-i]", { hasText: "src" }).click();
  await expect(rows.filter({ hasText: "pantoken" })).toBeVisible();
  await expect(filterInput(page)).toHaveValue("");
  await filterInput(page).press("Enter");

  await expect(picker(page)).toBeHidden();
  await expect(projectChip(page)).toContainText("src");
});

test("Tab autocompletes by descending into the filtered match", async ({
  page,
}) => {
  await openDraft(page);
  await projectChip(page).click();
  await expect(picker(page)).toBeVisible();

  await picker(page).locator(".home-btn").click();
  const rows = picker(page).locator(".row[data-i] .name");
  await expect(rows.filter({ hasText: "src" })).toBeVisible();

  // Type a fuzzy match for "src", then Tab to descend into it (shell-style).
  await filterInput(page).fill("sr");
  await expect(rows).toHaveCount(1);
  await filterInput(page).press("Tab");

  // We're now inside src: its children are visible and the filter has reset.
  await expect(picker(page).locator(".bc")).toContainText("src");
  await expect(rows.filter({ hasText: "pantoken" })).toBeVisible();
  await expect(filterInput(page)).toHaveValue("");
});

test("Escape clears the filter without closing the browser", async ({
  page,
}) => {
  await openDraft(page);
  await projectChip(page).click();
  await expect(picker(page)).toBeVisible();

  await filterInput(page).fill("some filter text");
  await filterInput(page).press("Escape");

  // The filter clears, and the picker stays open.
  await expect(filterInput(page)).toHaveValue("");
  await expect(picker(page)).toBeVisible();

  // Second Escape closes the picker.
  await filterInput(page).press("Escape");
  await expect(picker(page)).toBeHidden();
});
