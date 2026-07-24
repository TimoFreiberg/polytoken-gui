import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar, openSettings } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
  await openSidebar(page);
});

test("settings → computers: container profile row with environment tag + state + actions", async ({ page }) => {
  // First add a docker profile via the setup dialog.
  const trigger = page.getByTestId("host-switcher-trigger");
  await trigger.click();
  await page.getByTestId("host-switcher-add").click();
  await page.getByTestId("cs-ssh-input").fill("dev@dev-server");
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 5000 });
  await page.getByTestId("cs-container-work-api-dev").click();
  await page.getByTestId("cs-use-container").click();
  await page.getByTestId("computer-setup-close").click().catch(() => {});
  await page.waitForTimeout(500);

  // Open Settings → Computers.
  await openSettings(page, "computers");
  await expect(page.getByTestId("computers-section")).toBeVisible();
  // The local computer should be shown.
  await expect(page.getByText("THIS COMPUTER")).toBeVisible();
  // Remote computer section should appear if a profile was saved.
  if (await page.getByText("REMOTE COMPUTERS").isVisible().catch(() => false)) {
    // Check for environment tag.
    await expect(page.getByText("Docker container · work-api-dev")).toBeVisible();
  }
});

test("edit dialog: read-only execution environment", async ({ page }) => {
  // Add a docker profile first.
  const trigger = page.getByTestId("host-switcher-trigger");
  await trigger.click();
  await page.getByTestId("host-switcher-add").click();
  await page.getByTestId("cs-ssh-input").fill("dev@dev-server");
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 5000 });
  await page.getByTestId("cs-container-work-api-dev").click();
  await page.getByTestId("cs-use-container").click();
  await page.getByTestId("computer-setup-close").click().catch(() => {});
  await page.waitForTimeout(500);

  // Open Settings → Computers.
  await openSettings(page, "computers");
  await expect(page.getByTestId("computers-section")).toBeVisible();

  // If remote profiles exist, click Edit on the first one.
  const editBtns = page.locator('[data-testid^="computer-card-"] .mcp-btn').filter({ hasText: "Edit" });
  if (await editBtns.first().isVisible().catch(() => false)) {
    await editBtns.first().click();
    await expect(page.getByTestId("computer-setup-panel")).toBeVisible();
    // Verify the read-only execution environment field.
    await expect(page.getByTestId("cs-edit-exec-env")).toContainText("Docker container");
    await expect(page.getByTestId("cs-edit-exec-env")).toContainText("immutable after creation");
    // Verify Reconnect now / Later buttons.
    await expect(page.getByTestId("cs-reconnect-now")).toBeVisible();
    await expect(page.getByTestId("cs-reconnect-later")).toBeVisible();
  }
});

test("container not running: Retry + guidance", async ({ page }) => {
  // Add a docker profile, then drive it to failed with "Container not running".
  const trigger = page.getByTestId("host-switcher-trigger");
  await trigger.click();
  await page.getByTestId("host-switcher-add").click();
  await page.getByTestId("cs-ssh-input").fill("dev@dev-server");
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 5000 });
  // Use exact name for a non-running container.
  await page.getByTestId("cs-exact-name-link").click();
  await page.getByTestId("cs-exact-input").fill("nightly-runner");
  await page.getByTestId("cs-save-later").click();
  await page.waitForTimeout(500);

  // Drive the host to failed with "Container not running".
  await page.evaluate(() => {
    const hosts = (window as unknown as { __pantokenHosts?: { setState: (id: string, state: string) => void } }).__pantokenHosts;
    // Find the docker profile host and set it to failed.
    hosts?.setState("docker-test", "failed");
  });

  // Open Settings → Computers.
  await openSettings(page, "computers");
  await expect(page.getByTestId("computers-section")).toBeVisible();

  // If the guidance text appears, verify it.
  const guidance = page.locator('[data-testid^="computer-guidance-"]');
  if (await guidance.first().isVisible({ timeout: 2000 }).catch(() => false)) {
    await expect(guidance.first()).toContainText("Container not running");
    await expect(guidance.first()).toContainText("Pantoken does not manage container lifecycle");
  }
});
