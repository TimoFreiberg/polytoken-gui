import { expect, type Page, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => gotoFresh(page));

const picker = (page: Page) => page.getByTestId("dir-picker");
const pathInput = (page: Page) => page.getByLabel("Project directory path");
const projectChip = (page: Page) => page.getByTestId("draft-project-control");
const draftBox = (page: Page) =>
  page.getByPlaceholder("Describe a task or ask a question…");

async function openDraft(page: Page): Promise<void> {
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();
  await expect(draftBox(page)).toBeVisible();
}

async function openPicker(page: Page): Promise<void> {
  await openDraft(page);
  await projectChip(page).click();
  await expect(picker(page)).toBeVisible();
  await expect(pathInput(page)).toBeFocused();
}

test("desktop presents a centered server-filesystem command palette", async ({
  page,
}) => {
  await openPicker(page);
  await expect(
    picker(page).getByText("Choose project directory"),
  ).toBeVisible();
  await expect(page.getByTestId("dir-picker-server")).not.toHaveText("");
  await expect(
    picker(page).locator(".recent-chip, .bc, .home-btn, .foot"),
  ).toHaveCount(0);
  const box = await picker(page).boundingBox();
  const viewport = page.viewportSize()!;
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(560);
  expect(box!.width).toBeLessThanOrEqual(680);
  expect(Math.abs(box!.x + box!.width / 2 - viewport.width / 2)).toBeLessThan(
    2,
  );
});

test("prefix matches lead fuzzy matches and directories navigate before selection", async ({
  page,
}) => {
  await openPicker(page);
  await pathInput(page).fill("/Users/timo/src/pi");
  const names = picker(page).locator(".directory .name");
  await expect(names.first()).toHaveText("pi");
  await expect(names.nth(1)).toHaveText("pi-gui");

  await pathInput(page).press("Enter");
  await expect(pathInput(page)).toHaveValue("/Users/timo/src/pi/");
  await expect(page.getByTestId("use-current-directory")).toBeVisible();
  await expect(picker(page)).toBeVisible();

  await pathInput(page).press("Enter");
  await expect(picker(page)).toBeHidden();
  await expect(projectChip(page)).toContainText("pi");
});

test("arrow and Emacs-style keys move the active directory before opening it", async ({
  page,
}) => {
  await openPicker(page);
  const input = pathInput(page);
  await input.fill("/Users/timo/src/pi");
  await expect(picker(page).locator(".directory .name").first()).toHaveText(
    "pi",
  );
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(input).toHaveValue("/Users/timo/src/pi-gui/");

  await input.fill("/Users/timo/src/pi");
  await expect(picker(page).locator(".directory .name").first()).toHaveText(
    "pi",
  );
  await input.press("Control+n");
  await input.press("Enter");
  await expect(input).toHaveValue("/Users/timo/src/pi-gui/");

  await input.fill("/Users/timo/src/pi");
  await expect(picker(page).locator(".directory .name").first()).toHaveText(
    "pi",
  );
  await input.press("ArrowDown");
  await input.press("Control+p");
  await input.press("Enter");
  await expect(input).toHaveValue("/Users/timo/src/pi/");
});

test("desktop focus remains trapped between the visible modal controls", async ({
  page,
}) => {
  await openPicker(page);
  await pathInput(page).fill("/Users/timo/src/");
  const close = picker(page).locator(".close");
  const lastResult = picker(page).locator(".result").last();
  await expect(lastResult).toBeVisible();
  await close.focus();
  await close.press("Shift+Tab");
  await expect(lastResult).toBeFocused();
  await lastResult.press("Tab");
  await expect(close).toBeFocused();
});

test("Tab completes the selected directory and exact current paths can be chosen", async ({
  page,
}) => {
  await openPicker(page);
  await pathInput(page).fill("/Users/timo/src/sr");
  await expect(picker(page).locator(".directory .name").first()).toHaveText(
    "scratch",
  );
  await pathInput(page).press("Tab");
  await expect(pathInput(page)).toHaveValue("/Users/timo/src/scratch/");
  await expect(page.getByTestId("use-current-directory")).toBeVisible();
  await page.getByTestId("use-current-directory").click();
  await expect(projectChip(page)).toContainText("scratch");
});

test("Tab never commits an already exact directory", async ({ page }) => {
  await openPicker(page);
  await expect(page.getByTestId("use-current-directory")).toBeVisible();
  const initial = await pathInput(page).inputValue();
  await pathInput(page).press("Tab");
  await expect(picker(page)).toBeVisible();
  await expect(pathInput(page)).toHaveValue(initial);
});

test("Right Arrow completes only with a collapsed caret at the end", async ({
  page,
}) => {
  await openPicker(page);
  const input = pathInput(page);
  await input.fill("/Users/timo/src/pi");
  await expect(picker(page).locator(".directory .name").first()).toHaveText(
    "pi",
  );
  await input.evaluate((node: HTMLInputElement) =>
    node.setSelectionRange(5, 5),
  );
  await input.press("ArrowRight");
  await expect(input).toHaveValue("/Users/timo/src/pi");
  await input.evaluate((node: HTMLInputElement) =>
    node.setSelectionRange(node.value.length, node.value.length),
  );
  await input.press("ArrowRight");
  await expect(input).toHaveValue("/Users/timo/src/pi/");
});

test("Backspace and Option+Backspace remain ordinary text editing", async ({
  page,
}) => {
  await openPicker(page);
  const input = pathInput(page);
  await input.fill("/Users/timo/src/pantoken");
  await input.press("Backspace");
  await expect(input).toHaveValue("/Users/timo/src/pantoke");
  // Word-delete is platform-specific: Option+Backspace on macOS, Ctrl+Backspace on
  // Linux/Windows. CI runs Chromium on Linux (see hotkeys.e2e.ts), so pick the
  // modifier that actually deletes a word on the host.
  const wordDelete =
    process.platform === "darwin" ? "Alt+Backspace" : "Control+Backspace";
  await input.press(wordDelete);
  await expect(input).not.toHaveValue("/Users/timo/src/pantoke");
  await expect(picker(page)).toBeVisible();
});

test("home-relative paths resolve on the server and hidden directories remain visible", async ({
  page,
}) => {
  await openPicker(page);
  await pathInput(page).fill("~/.c");
  await expect(picker(page).locator(".directory .name").first()).toHaveText(
    ".config",
  );
  await pathInput(page).press("Tab");
  await expect(pathInput(page)).toHaveValue("~/.config/");
  await expect(page.getByTestId("use-current-directory")).toBeVisible();
});

test("unreadable paths show a bounded error and rapid typing keeps the latest result", async ({
  page,
}) => {
  await openPicker(page);
  await pathInput(page).fill("/not/a/readable/directory/");
  await expect(picker(page).getByRole("alert")).toContainText("can’t be read");

  await pathInput(page).fill("/Users/timo/src/p");
  await pathInput(page).fill("/Users/timo/src/scr");
  await expect(picker(page).locator(".directory .name").first()).toHaveText(
    "scratch",
  );
  await expect(
    picker(page).locator(".directory .name", { hasText: "pantoken" }),
  ).toHaveCount(0);
});

test("Escape closes without abandoning the draft and restores composer focus", async ({
  page,
}) => {
  await openDraft(page);
  await draftBox(page).fill("keep me");
  await projectChip(page).click();
  await pathInput(page).press("Escape");
  await expect(picker(page)).toBeHidden();
  await expect(draftBox(page)).toHaveValue("keep me");
  // Issue #54: closing the DirPicker returns focus to the composer textarea
  // (typing a prompt is the common next step), not the project chip.
  await expect(draftBox(page)).toBeFocused();
});

test("⌥P opens the picker without changing the draft", async ({ page }) => {
  await openDraft(page);
  await draftBox(page).focus();
  await draftBox(page).press("Alt+p");
  await expect(pathInput(page)).toBeFocused();
  await expect(draftBox(page)).toHaveValue("");
});
