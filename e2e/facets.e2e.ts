import { expect, test } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("facet badge opens a picker listing available facets and switches", async ({
  page,
}) => {
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toContainText("Execute");

  // Open the picker.
  await badge.click();
  const panel = page.getByRole("listbox", { name: "Facet" });
  await expect(panel).toBeVisible();

  // Three facets available (the mock returns execute + plan builtins + a custom
  // "research", so the picker exercises a non-builtin, dynamically-derived name).
  await expect(panel.getByRole("option")).toHaveCount(3);
  await expect(panel.getByRole("option", { name: "Execute" })).toBeVisible();
  await expect(panel.getByRole("option", { name: "Plan" })).toBeVisible();
  await expect(panel.getByRole("option", { name: "Research" })).toBeVisible();

  // Switch to Plan.
  await panel.getByRole("option", { name: "Plan" }).click();
  await expect(badge).toContainText("Plan");
  await expect(badge).toHaveClass(/plan/);

  // Switch back to Execute.
  await badge.click();
  await page
    .getByRole("listbox", { name: "Facet" })
    .getByRole("option", { name: "Execute" })
    .click();
  await expect(badge).toContainText("Execute");
  await expect(badge).not.toHaveClass(/plan/);
});

test("facet badge has a reload button that refreshes the list", async ({
  page,
}) => {
  const badge = page.getByTestId("facet-badge");
  await badge.click();
  const reload = page.getByTitle("Reload the facet list from disk");
  await expect(reload).toBeVisible();
  // Click it — should close the panel without error.
  await reload.click();
  await expect(page.getByRole("listbox", { name: "Facet" })).toHaveCount(0);
});
