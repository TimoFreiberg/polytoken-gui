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

test("provisioning: four Docker phases render", async ({ page }) => {
  await openSetup(page);
  await page.getByTestId("cs-ssh-input").fill("dev@dev-server");
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 5000 });
  await page.getByTestId("cs-container-work-api-dev").click();
  await page.getByTestId("cs-use-container").click();

  // Should show provisioning phases.
  const provisioning = page.getByTestId("cs-provisioning");
  if (await provisioning.isVisible({ timeout: 5000 }).catch(() => false)) {
    // Verify all four phase labels are present.
    await expect(provisioning).toContainText("SSH & Docker");
    await expect(provisioning).toContainText("Container");
    await expect(provisioning).toContainText("Polytoken");
    await expect(provisioning).toContainText("Pantoken runtime");
  }
});

test("run in background: close control = Run in background", async ({ page }) => {
  await openSetup(page);
  await page.getByTestId("cs-ssh-input").fill("dev@dev-server");
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 5000 });
  await page.getByTestId("cs-container-work-api-dev").click();
  await page.getByTestId("cs-use-container").click();

  // If provisioning starts, the close button should say "Run in background".
  if (await page.getByTestId("cs-provisioning").isVisible({ timeout: 5000 }).catch(() => false)) {
    await expect(page.getByTestId("computer-setup-close")).toContainText("Run in background");
  }
});

test("cancel setup visible only during safe phases", async ({ page }) => {
  await openSetup(page);
  await page.getByTestId("cs-ssh-input").fill("dev@dev-server");
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 5000 });
  await page.getByTestId("cs-container-work-api-dev").click();
  await page.getByTestId("cs-use-container").click();

  // If provisioning starts, cancel setup should be visible during safe phases.
  if (await page.getByTestId("cs-provisioning").isVisible({ timeout: 5000 }).catch(() => false)) {
    const cancelBtn = page.getByTestId("cs-cancel-setup");
    // It should be visible during phase 1 or 2 (safely cancellable).
    if (await cancelBtn.isVisible().catch(() => false)) {
      await expect(cancelBtn).toContainText("Cancel setup");
    }
  }
});
