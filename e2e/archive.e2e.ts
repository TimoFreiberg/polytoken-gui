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
