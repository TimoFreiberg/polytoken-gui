import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("adventurous handoff toggles from the facet menu and persists in the session state", async ({
  page,
}) => {
  // The toggle lives in the facet picker (it's a plan-mode modifier in spirit),
  // next to the composer — per-session config near the prompt box.
  await page.getByTestId("facet-badge").click();
  await expect(page.getByTestId("adventurous-handoff")).toHaveCount(0);
  await page.getByRole("option", { name: "Plan" }).click();
  await page.getByTestId("facet-badge").click();
  const toggle = page.getByTestId("adventurous-handoff");
  await expect(toggle).toBeVisible();

  // Default: off (the mock seeds adventurousHandoff: false).
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(toggle).toHaveAttribute("aria-label", "Adventurous handoff");

  // Toggle on — the menu stays open so the state flip is visible.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(toggle).toHaveClass(/on/);

  // Toggle back off.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(toggle).not.toHaveClass(/on/);

  // The modifier is Plan-only, not merely a generic live-session control.
  await page.getByRole("option", { name: "Execute" }).click();
  await page.getByTestId("facet-badge").click();
  await expect(page.getByTestId("adventurous-handoff")).toHaveCount(0);
});

test("the handoff toggle hides while drafting a new session", async ({
  page,
}) => {
  // A draft has no live daemon session, so the per-session flag can't apply yet.
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();
  await page.getByTestId("facet-badge").click();
  await expect(page.getByRole("listbox", { name: "Facet" })).toBeVisible();
  await expect(page.getByTestId("adventurous-handoff")).toHaveCount(0);
});
