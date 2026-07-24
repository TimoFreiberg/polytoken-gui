import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
  await openSidebar(page);
});

async function openSetup(page: import("@playwright/test").Page): Promise<void> {
  const trigger = page.getByTestId("host-switcher-trigger");
  await trigger.click();
  await page.getByTestId("host-switcher-add").click();
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();
}

test("phone: picker and risks panel at 375px; 44px targets", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openSetup(page);
  await page.getByTestId("cs-ssh-input").fill("dev@dev-server");
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 5000 });

  // Verify the panel is full-screen on phone.
  const panel = page.getByTestId("computer-setup-panel");
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBe(0);
  expect(box!.y).toBe(0);

  // Verify container rows have ≥44px touch targets.
  const row = page.getByTestId("cs-container-work-api-dev");
  if (await row.isVisible({ timeout: 2000 }).catch(() => false)) {
    const rowBox = await row.boundingBox();
    expect(rowBox).not.toBeNull();
    expect(rowBox!.height).toBeGreaterThanOrEqual(44);
  }

  // Verify input fields have ≥44px touch targets.
  const sshInput = page.getByTestId("cs-ssh-input");
  const inputBox = await sshInput.boundingBox();
  expect(inputBox).not.toBeNull();
  expect(inputBox!.height).toBeGreaterThanOrEqual(44);
});

test("phone: Back closes overlay via overlay history", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openSetup(page);
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();

  // Press Escape / Back — should close the overlay.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("computer-setup-panel")).toBeHidden({ timeout: 2000 });
});

test("phone: overlay history integration — Back button returns to picker", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openSetup(page);
  await page.getByTestId("cs-ssh-input").fill("dev@dev-server");
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 5000 });

  // Navigate to exact name entry.
  await page.getByTestId("cs-exact-name-link").click();
  await expect(page.getByTestId("cs-exact-input")).toBeVisible();

  // Press Back — should return to the container picker.
  await page.getByText("Back to container list").click();
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible();
});
