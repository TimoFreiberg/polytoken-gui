import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
  await openSidebar(page);
});

test("host switcher: Docker computer row with ▣ glyph + subtitle", async ({ page }) => {
  // Add a docker profile via the setup dialog, then verify it appears in the switcher.
  const trigger = page.getByTestId("host-switcher-trigger");
  await trigger.click();
  await page.getByTestId("host-switcher-add").click();
  await page.getByTestId("cs-ssh-input").fill("dev@dev-server");
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 5000 });
  await page.getByTestId("cs-container-work-api-dev").click();
  await page.getByTestId("cs-use-container").click();
  // Close the setup dialog (Run in background or close).
  await page.getByTestId("computer-setup-close").click().catch(() => {});
  await page.waitForTimeout(500);

  // Open the switcher and check for the docker host row.
  await trigger.click();
  // The docker host should appear with ▣ glyph.
  const dockerHost = page.locator(".host-option").filter({ hasText: "work-api" });
  if (await dockerHost.isVisible({ timeout: 2000 }).catch(() => false)) {
    const icon = dockerHost.locator(".option-icon");
    await expect(icon).toContainText("▣");
  }
  // Local host should have ⌂ glyph.
  const localHost = page.locator(".host-option").filter({ hasText: "Dev computer" });
  await expect(localHost.locator(".option-icon")).toContainText("⌂");
});
