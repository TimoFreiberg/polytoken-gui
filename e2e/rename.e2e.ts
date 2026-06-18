import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("the overflow menu renames a session, updating the row in place", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  const row = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Explore the fold reducer" });
  await expect(row).toBeVisible();

  // Open the overflow menu and pick Rename.
  await row.hover();
  await row.getByTestId("session-menu").click();
  await sidebar.getByRole("menuitem", { name: "Rename", exact: true }).click();

  // The inline editor appears, prefilled with the current name (the row is gone —
  // the form replaces it in place).
  const input = sidebar.locator(".rename-input");
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("Explore the fold reducer");

  // Type a new name and save.
  await input.fill("Fold reducer deep-dive");
  await sidebar.getByRole("button", { name: "Save", exact: true }).click();

  // The row reflects the new name (optimistic + server reconcile); the old one is gone.
  await expect(sidebar.getByText("Fold reducer deep-dive")).toBeVisible();
  await expect(sidebar.getByText("Explore the fold reducer")).toHaveCount(0);
});

test("Escape cancels a rename without changing the name", async ({ page }) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  const row = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Wire up the WebSocket bridge" });
  await row.hover();
  await row.getByTestId("session-menu").click();
  await sidebar.getByRole("menuitem", { name: "Rename", exact: true }).click();

  const input = sidebar.locator(".rename-input");
  await input.fill("Discarded name");
  await input.press("Escape");

  // The editor closes and the original name is intact.
  await expect(sidebar.locator(".rename-input")).toHaveCount(0);
  await expect(sidebar.getByText("Wire up the WebSocket bridge")).toBeVisible();
  await expect(sidebar.getByText("Discarded name")).toHaveCount(0);
});
