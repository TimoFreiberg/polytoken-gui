import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
  await openSidebar(page);
});

test("phone picker is a full-screen sheet with labeled touch-safe controls", async ({ page }) => {
  const trigger = page.getByTestId("host-switcher-trigger");
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Choose computer" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBe(0);
  expect(box!.y).toBe(0);
  await expect(dialog.getByRole("button", { name: "Close computer picker" })).toHaveCSS("min-height", "44px");
  for (const option of await dialog.locator(".host-option").all()) {
    const optionBox = await option.boundingBox();
    expect(optionBox).not.toBeNull();
    expect(optionBox!.height).toBeGreaterThanOrEqual(44);
  }
});

test("phone Escape closes and restores focus, and Back closes before navigation", async ({ page }) => {
  const trigger = page.getByTestId("host-switcher-trigger");
  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Choose computer" })).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await page.goBack();
  await expect(page.getByRole("dialog", { name: "Choose computer" })).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("phone picker focus stays within the sheet when tabbing", async ({ page }) => {
  const trigger = page.getByTestId("host-switcher-trigger");
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Choose computer" });
  const close = dialog.getByRole("button", { name: "Close computer picker" });
  await close.focus();
  await page.keyboard.press("Shift+Tab");
  // The management buttons (Add computer, Manage computers) are now enabled
  // and sit after the host options, so Shift+Tab from Close lands on the last
  // management button.
  await expect(dialog.getByTestId("manage-computers-btn")).toBeFocused();
});
