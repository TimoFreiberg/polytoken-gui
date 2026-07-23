import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
  await openSidebar(page);
});

test("desktop picker is local-first, exposes identity, and closes on Escape/outside click", async ({ page }) => {
  const switcher = page.getByTestId("host-switcher");
  const trigger = switcher.getByTestId("host-switcher-trigger");
  await expect(trigger).toContainText("Dev computer");
  await expect(trigger).toContainText("This computer");
  await trigger.click();
  const options = page.locator(".host-option");
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toContainText("Dev computer");
  await expect(options.nth(1)).toContainText("Dev remote");
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Choose computer" })).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.mouse.click(900, 100);
  await expect(page.getByRole("dialog", { name: "Choose computer" })).toBeHidden();
});

test("collapsed sidebar keeps the selected host identity in the header", async ({ page }) => {
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(page.getByTestId("header-host-identity")).toContainText("pantoken · Dev computer");
});

test("browser single-host mode suppresses native host controls", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("host-switcher")).toHaveCount(0);
  await expect(page.getByTestId("header-host-identity")).toHaveCount(0);
});
