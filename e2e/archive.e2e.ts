import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("active-only filter hides archived + stale sessions; show-all reveals them", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  // Default is active-only: the archived fixture and the stale (>7d) fixture are hidden.
  await expect(sidebar.getByText("Archived experiment")).toHaveCount(0);
  await expect(sidebar.getByText("Old spike")).toHaveCount(0);
  // The stale session is alone in its project, so the whole group drops out too.
  await expect(sidebar.getByText("stale-proj", { exact: true })).toHaveCount(0);
  // The hint tells you something's tucked away (1 archived + 1 stale = 2).
  await expect(sidebar.getByText(/2 hidden/)).toBeVisible();

  // Flip to "show all" — everything appears, including its own project group.
  await sidebar.getByTestId("filter-toggle").click();
  await expect(sidebar.getByText("Archived experiment")).toBeVisible();
  await expect(sidebar.getByText("Old spike")).toBeVisible();
  await expect(sidebar.getByText("stale-proj", { exact: true })).toBeVisible();
  // The hidden hint is gone once nothing is filtered out.
  await expect(sidebar.getByText(/hidden/)).toHaveCount(0);
});

test("the '{N} hidden' count is itself clickable to reveal everything", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  // Default active-only view hides the archived + stale fixtures behind the count.
  const hint = sidebar.getByTestId("hidden-count");
  await expect(hint).toHaveText(/2 hidden/);
  await expect(sidebar.getByText("Archived experiment")).toHaveCount(0);

  // Clicking the count (not the separate filter toggle) reveals them.
  await hint.click();
  await expect(sidebar.getByText("Archived experiment")).toBeVisible();
  await expect(sidebar.getByText("Old spike")).toBeVisible();
  await expect(sidebar.getByTestId("hidden-count")).toHaveCount(0);
});

test("archiving offers an Undo toast that restores the session", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  const row = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Explore the fold reducer" });
  await expect(row).toBeVisible();
  await row.locator(".row").click({ button: "right" });
  await sidebar.getByRole("menuitem", { name: "Archive", exact: true }).click();

  // The row vanishes from the active view AND a toast offers a one-tap undo.
  await expect(sidebar.getByText("Explore the fold reducer")).toHaveCount(0);
  const toast = page.getByTestId("toast").filter({ hasText: "Archived" });
  await expect(toast).toBeVisible();

  // Undo restores it (un-archives), and the toast clears.
  await toast.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(sidebar.getByText("Explore the fold reducer")).toBeVisible();
});

test("right-clicking a session row opens its overflow menu", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  const row = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Explore the fold reducer" });
  await expect(row).toBeVisible();

  // The menu is closed to start with — no hover, no ⋯ click.
  await expect(
    row.getByRole("menuitem", { name: "Archive", exact: true }),
  ).toHaveCount(0);

  // Right-click the row itself opens the same menu the ⋯ trigger would.
  await row.locator(".row").click({ button: "right" });
  await expect(
    row.getByRole("menuitem", { name: "Archive", exact: true }),
  ).toBeVisible();

  // And it drives the same action.
  await sidebar.getByRole("menuitem", { name: "Archive", exact: true }).click();
  await expect(sidebar.getByText("Explore the fold reducer")).toHaveCount(0);
});

test("the overflow menu copies the pi session id to the clipboard", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  // "Explore the fold reducer" is the `older-session` fixture.
  const row = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Explore the fold reducer" });
  await expect(row).toBeVisible();

  await row.hover();
  await row.getByTestId("session-menu").click();
  await sidebar.getByTestId("copy-session-id").click();

  // Clipboard holds the raw pi session id, and the menu closed itself.
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe("older-session");
  await expect(sidebar.getByTestId("copy-session-id")).toHaveCount(0);
});

test("pressing 'a' while the menu is open archives the targeted session", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  const row = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Explore the fold reducer" });
  await expect(row).toBeVisible();

  // Open the floating menu, then drive the archive via its keyboard shortcut.
  await row.hover();
  await row.getByTestId("session-menu").click();
  await expect(
    sidebar.getByRole("menuitem", { name: "Archive", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("a");

  // Archived → gone from the active list, and the menu closed itself.
  await expect(sidebar.getByText("Explore the fold reducer")).toHaveCount(0);
  await expect(
    sidebar.getByRole("menuitem", { name: "Archive", exact: true }),
  ).toHaveCount(0);
});

test("the overflow menu archives a session, hiding it from the active list", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  // "Explore the fold reducer" (older-session) is active + visible by default.
  const row = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Explore the fold reducer" });
  await expect(row).toBeVisible();

  // Open its overflow menu and archive it.
  await row.hover();
  await row.getByTestId("session-menu").click();
  await sidebar.getByRole("menuitem", { name: "Archive", exact: true }).click();

  // It disappears from the active view (optimistic + server reconcile).
  await expect(sidebar.getByText("Explore the fold reducer")).toHaveCount(0);

  // Under "show all" it's back, marked archived, and the menu now offers Unarchive.
  await sidebar.getByTestId("filter-toggle").click();
  const archivedRow = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Explore the fold reducer" });
  await expect(archivedRow).toBeVisible();
  await expect(archivedRow.getByText("archived")).toBeVisible();

  await archivedRow.hover();
  await archivedRow.getByTestId("session-menu").click();
  await sidebar
    .getByRole("menuitem", { name: "Unarchive", exact: true })
    .click();

  // The archived flag clears (still visible since we're in show-all mode).
  await expect(archivedRow.getByText("archived")).toHaveCount(0);
});
