import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
  await openSidebar(page);
});

/** Helper: open the computer setup dialog via the host switcher's Add computer button. */
async function openSetup(page: import("@playwright/test").Page): Promise<void> {
  const trigger = page.getByTestId("host-switcher-trigger");
  await trigger.click();
  await page.getByTestId("host-switcher-add").click();
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();
}

test("setup dialog stage 1: SSH fields + segmented control; Test button disabled until SSH destination non-empty", async ({ page }) => {
  await openSetup(page);
  // Test button is disabled when SSH destination is empty.
  await expect(page.getByTestId("cs-test-ssh")).toBeDisabled();
  // Fill SSH destination — Test button enables.
  await page.getByTestId("cs-ssh-input").fill("dev@dev-server");
  await expect(page.getByTestId("cs-test-ssh")).toBeEnabled();
  // Name does not block testing.
  await expect(page.getByTestId("cs-name-input")).toBeVisible();
});

test("setup dialog two-stage flow: SSH test → container picker", async ({ page }) => {
  await openSetup(page);
  await page.getByTestId("cs-ssh-input").fill("dev@dev-server");
  await page.getByTestId("cs-test-ssh").click();
  // Wait for the container picker to appear.
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 5000 });
  await expect(page.getByText("Running containers")).toBeVisible();
  // Should have the default containers from the dev provider.
  await expect(page.getByTestId("cs-container-work-api-dev")).toBeVisible();
});

test("use this container starts provisioning", async ({ page }) => {
  await openSetup(page);
  await page.getByTestId("cs-ssh-input").fill("dev@dev-server");
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 5000 });
  // Select a container.
  await page.getByTestId("cs-container-work-api-dev").click();
  // Use this container button appears.
  await expect(page.getByTestId("cs-use-container")).toBeVisible();
  await page.getByTestId("cs-use-container").click();
  // Should transition to provisioning or risks.
  await expect(page.getByTestId("cs-provisioning")).toBeVisible({ timeout: 5000 });
});

test("container picker: row shows name, image, user, status", async ({ page }) => {
  await openSetup(page);
  await page.getByTestId("cs-ssh-input").fill("dev@dev-server");
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 5000 });
  const row = page.getByTestId("cs-container-work-api-dev");
  await expect(row).toContainText("work-api-dev");
  await expect(row).toContainText("node:20-alpine");
  await expect(row).toContainText("dev");
  await expect(row).toContainText("running");
});

test("exact-name entry for non-running container: warning box + Save & connect later", async ({ page }) => {
  await openSetup(page);
  await page.getByTestId("cs-ssh-input").fill("dev@dev-server");
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 5000 });
  // Click the exact name link.
  await page.getByTestId("cs-exact-name-link").click();
  await expect(page.getByTestId("cs-exact-input")).toBeVisible();
  await expect(page.getByTestId("cs-not-running-warning")).toBeVisible();
  // Save & connect later is disabled until a name is entered.
  await expect(page.getByTestId("cs-save-later")).toBeDisabled();
  await page.getByTestId("cs-exact-input").fill("nightly-runner");
  await expect(page.getByTestId("cs-save-later")).toBeEnabled();
});

test("customize target disclosure: user + root pre-filled", async ({ page }) => {
  await openSetup(page);
  await page.getByTestId("cs-ssh-input").fill("dev@dev-server");
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 5000 });
  await page.getByTestId("cs-container-work-api-dev").click();
  await page.getByTestId("cs-customize-toggle").click();
  await expect(page.getByTestId("cs-customize")).toBeVisible();
  await expect(page.getByTestId("cs-user-input")).toHaveValue("dev");
  await expect(page.getByTestId("cs-root-input")).toContainText("/home/dev/.local/share/pantoken");
});
