import { expect, test } from "@playwright/test";
import { gotoFresh, openSettings } from "./helpers.js";

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
  await expect(badge).toHaveClass(/facet-(plan|auto)/);

  // Switch back to Execute.
  await badge.click();
  await page
    .getByRole("listbox", { name: "Facet" })
    .getByRole("option", { name: "Execute" })
    .click();
  await expect(badge).toContainText("Execute");
  await expect(badge).not.toHaveClass(/facet-(plan|auto)/);
});

test("facet menu has no reload button; it lives in Settings → Environment", async ({
  page,
}) => {
  // The reload button was moved out of the facet menu to Settings.
  const badge = page.getByTestId("facet-badge");
  await badge.click();
  const panel = page.getByRole("listbox", { name: "Facet" });
  await expect(panel).toBeVisible();
  await expect(panel.getByTitle("Reload the facet list from disk")).toHaveCount(0);
  // Close the facet menu before opening Settings (the backdrop would intercept).
  await page.keyboard.press("Escape");
  await expect(panel).not.toBeVisible();
  // Open Settings → Environment → find the reload button there.
  await openSettings(page, "environment");
  const reload = page.getByTitle("Reload the facet list from disk");
  await expect(reload).toBeVisible();
  // Click it — the Settings panel stays open and no error appears.
  await reload.click();
  await expect(page.getByTestId("settings-panel")).toBeVisible();
});
