import { expect, test, type Locator, type Page } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
  await openSidebar(page);
});

async function expectTapTarget(locator: Locator, minimum = 44): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, "control should have a layout box").not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(minimum);
  expect(box!.height).toBeGreaterThanOrEqual(minimum);
}

function sessionRow(page: Page, name: string): Locator {
  return page
    .getByTestId("sidebar")
    .locator(".row-wrap")
    .filter({ hasText: name });
}

test("Sessions has a deliberate touch-safe top bar and flat list rows", async ({
  page,
}) => {
  const sidebar = page.getByTestId("sidebar");
  await expect(sidebar.getByRole("heading", { name: "Sessions" })).toBeVisible();

  await expectTapTarget(
    sidebar.getByRole("button", { name: "Close sessions" }),
  );
  await expectTapTarget(sidebar.getByTestId("sidebar-search-toggle"));
  await expectTapTarget(sidebar.getByTestId("filter-toggle"));
  await expectTapTarget(sidebar.getByText("New session…"), 48);

  const project = sidebar
    .locator(".group")
    .filter({ has: page.locator(".proj", { hasText: "pantoken" }) });
  await expectTapTarget(project.locator(".group-toggle"));
  await expectTapTarget(
    project.getByRole("button", { name: "New session in pantoken" }),
  );

  const line = sessionRow(page, "Explore the fold reducer");
  await expectTapTarget(line.locator("button.row"), 48);
  await expectTapTarget(line.getByTestId("session-menu"));

  // Phone session rows stay flat: selection/hover may tint a row, but does not
  // introduce an individual card outline.
  const inactive = line.locator("button.row");
  await expect(inactive).toHaveCSS("border-top-width", "0px");
  await expect(inactive).toHaveCSS("border-right-width", "0px");
  await expect(inactive).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
});

test("search uses the full top bar and Back closes search before Sessions", async ({
  page,
}) => {
  const sidebar = page.getByTestId("sidebar");
  await sidebar.getByTestId("sidebar-search-toggle").click();
  const search = sidebar.getByRole("textbox", { name: "Search sessions" });
  await expect(search).toBeVisible();

  const searchBox = await search.boundingBox();
  const sidebarBox = await sidebar.boundingBox();
  expect(searchBox!.width).toBeGreaterThan(sidebarBox!.width - 80);
  await search.fill("fold reducer");
  await expect(sidebar.getByText("quick scratch session")).toHaveCount(0);

  await page.goBack();
  await expect(search).toBeHidden();
  await expect(sidebar).toHaveAttribute("data-open", "true");
  await expect(sidebar.getByText("quick scratch session")).toBeVisible();

  await sidebar.getByTestId("sidebar-search-toggle").click();
  await sidebar.getByTestId("sidebar-search-close").click();
  await expect(search).toBeHidden();
  await expect(sidebar).toHaveAttribute("data-open", "true");
  await page.goBack();
  await expect(sidebar).toHaveAttribute("data-open", "false");
});

test("session actions use a labeled sheet; Cancel and Back return to Sessions", async ({
  page,
}) => {
  const sidebar = page.getByTestId("sidebar");
  const overflow = sessionRow(page, "Explore the fold reducer").getByTestId(
    "session-menu",
  );

  await expect(overflow).toHaveAttribute("aria-haspopup", "dialog");
  await overflow.click();
  const sheet = page.getByRole("dialog", { name: "Session actions" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Cancel" })).toBeVisible();
  const firstAction = sheet.getByRole("button", { name: "Copy session ID" });
  await expect(firstAction).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(sheet.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(firstAction).toBeFocused();
  for (const action of [
    "Copy session ID",
    "Rename",
    "Reload session",
    "Detach session",
    "Archive",
    "Cancel",
  ]) {
    await expectTapTarget(
      sheet.getByRole("button", { name: action, exact: true }),
      48,
    );
  }

  await sheet.getByRole("button", { name: "Cancel" }).click();
  await expect(sheet).toBeHidden();
  await expect(sidebar).toHaveAttribute("data-open", "true");
  await expect(overflow).toBeFocused();
  await page.goBack();
  await expect(sidebar).toHaveAttribute("data-open", "false");

  await openSidebar(page);
  await overflow.click();
  await expect(sheet).toBeVisible();
  await page.goBack();
  await expect(sheet).toBeHidden();
  await expect(sidebar).toHaveAttribute("data-open", "true");
  await expect(overflow).toBeFocused();
  await page.goBack();
  await expect(sidebar).toHaveAttribute("data-open", "false");
});

test("sheet actions copy, rename, and archive without selecting the row", async ({
  page,
}) => {
  const sidebar = page.getByTestId("sidebar");
  const row = sessionRow(page, "Explore the fold reducer");
  const activeBefore = await sidebar.locator("button.row.active").textContent();

  await row.getByTestId("session-menu").click();
  await page
    .getByRole("dialog", { name: "Session actions" })
    .getByRole("button", { name: "Copy session ID" })
    .click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "older-session",
  );
  await expect(sidebar).toHaveAttribute("data-open", "true");

  await row.getByTestId("session-menu").click();
  await page
    .getByRole("dialog", { name: "Session actions" })
    .getByRole("button", { name: "Rename", exact: true })
    .click();
  const rename = sidebar.getByRole("textbox", { name: "New session name" });
  await rename.fill("Fold reducer on phone");
  await sidebar.getByRole("button", { name: "Save", exact: true }).click();
  await expect(sidebar.getByText("Fold reducer on phone")).toBeVisible();
  await expect(sidebar.locator("button.row.active")).toContainText(
    activeBefore!.trim(),
  );

  const renamed = sessionRow(page, "Fold reducer on phone");
  await renamed.getByTestId("session-menu").click();
  await page
    .getByRole("dialog", { name: "Session actions" })
    .getByRole("button", { name: "Archive", exact: true })
    .click();
  await expect(renamed).toHaveCount(0);
  await expect(
    sidebar.getByTestId("toast").filter({ hasText: "Archived" }),
  ).toBeVisible();
});

test("worktree cleanup keeps its destructive two-step confirmation", async ({
  page,
}) => {
  const sidebar = page.getByTestId("sidebar");
  await sidebar.getByText("New session…").click();
  await page.getByRole("button", { name: "Enable worktree isolation" }).click();
  const composer = page.getByPlaceholder(
    "Describe a task or ask a question…",
  );
  await composer.fill("mobile worktree cleanup");
  await page.getByRole("button", { name: "Create session and send" }).click();

  await openSidebar(page);
  const worktreeRow = sidebar
    .locator("li.row-wrap")
    .filter({ has: page.locator(".wt") });
  await expect(worktreeRow).toBeVisible();
  await worktreeRow.getByTestId("session-menu").click();
  const sheet = page.getByRole("dialog", { name: "Session actions" });
  await expect(
    sheet.getByRole("button", { name: "Copy worktree path" }),
  ).toBeVisible();
  await sheet.getByTestId("cleanup-worktree").click();
  await expect(sheet.getByTestId("confirm-cleanup-worktree")).toBeVisible();
  await expectTapTarget(sheet.getByTestId("confirm-cleanup-worktree"), 48);
  await sheet.getByTestId("confirm-cleanup-worktree").click();
  await expect(sidebar.locator(".wt")).toHaveCount(0);
});

test("selecting a session closes Sessions and the filter preference persists", async ({
  page,
}) => {
  const sidebar = page.getByTestId("sidebar");
  const filter = sidebar.getByTestId("filter-toggle");
  await filter.click();
  await expect(filter).toHaveAttribute("aria-pressed", "true");

  await page.reload();
  await openSidebar(page);
  await expect(sidebar.getByTestId("filter-toggle")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await sidebar.getByText("Explore the fold reducer").click();
  await expect(sidebar).toHaveAttribute("data-open", "false");
  await expect(page.locator("header .title")).toContainText(
    "Explore the fold reducer",
  );
});
