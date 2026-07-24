import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar, openSettings } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
  await openSidebar(page);
});

/** Helper: add a docker profile and return the profile id. */
async function addDockerProfile(page: import("@playwright/test").Page): Promise<string | null> {
  const trigger = page.getByTestId("host-switcher-trigger");
  await trigger.click();
  await page.getByTestId("host-switcher-add").click();
  await page.getByTestId("cs-ssh-input").fill("dev@dev-server");
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 5000 });
  await page.getByTestId("cs-container-work-api-dev").click();
  await page.getByTestId("cs-use-container").click();
  await page.waitForTimeout(1000);
  await page.getByTestId("computer-setup-close").click().catch(() => {});
  await page.waitForTimeout(500);
  const profiles = await page.evaluate(() => {
    const hosts = (window as unknown as { __pantokenHosts?: { listProfiles: () => Promise<{ id: string; executionTarget: { kind: string } }[]> } }).__pantokenHosts;
    return hosts?.listProfiles();
  });
  if (profiles && profiles.length > 0) {
    const docker = profiles.find((p) => p.executionTarget?.kind === "dockerContainer");
    return docker?.id ?? null;
  }
  return null;
}

test("settings → computers: container profile row with environment tag", async ({ page }) => {
  await addDockerProfile(page);

  await openSettings(page, "computers");
  await expect(page.getByTestId("computers-section")).toBeVisible();
  await expect(page.getByText("THIS COMPUTER")).toBeVisible();
  await expect(page.getByText("REMOTE COMPUTERS")).toBeVisible();
  await expect(page.getByText("Docker container · work-api-dev")).toBeVisible();
});

test("edit dialog: read-only execution environment; Reconnect now / Later", async ({ page }) => {
  await addDockerProfile(page);

  await openSettings(page, "computers");
  await expect(page.getByTestId("computers-section")).toBeVisible();
  // Click Edit on the first docker profile.
  const editBtn = page.locator('[data-testid^="computer-card-"] .mcp-btn').filter({ hasText: "Edit" }).first();
  await expect(editBtn).toBeVisible();
  await editBtn.click();
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();
  await expect(page.getByTestId("cs-edit-exec-env")).toContainText("Docker container");
  await expect(page.getByTestId("cs-edit-exec-env")).toContainText("immutable after creation");
  await expect(page.getByTestId("cs-reconnect-now")).toBeVisible();
  await expect(page.getByTestId("cs-reconnect-later")).toBeVisible();
});

test("container not running: Retry + guidance", async ({ page }) => {
  // Add a docker profile via exact name (non-running container).
  const trigger = page.getByTestId("host-switcher-trigger");
  await trigger.click();
  await page.getByTestId("host-switcher-add").click();
  await page.getByTestId("cs-ssh-input").fill("dev@dev-server");
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 5000 });
  await page.getByTestId("cs-exact-name-link").click();
  await page.getByTestId("cs-exact-input").fill("nightly-runner");
  await page.getByTestId("cs-save-later").click();
  await page.waitForTimeout(500);

  // Get the profile id and drive it to failed.
  const profileId = await page.evaluate(() => {
    const hosts = (window as unknown as { __pantokenHosts?: { listProfiles: () => Promise<{ id: string; executionTarget: { kind: string; containerName?: string } }[]>; setState: (id: string, state: string) => void } }).__pantokenHosts;
    return hosts?.listProfiles().then((ps) => {
      const docker = ps.find((p) => p.executionTarget?.kind === "dockerContainer" && p.executionTarget?.containerName === "nightly-runner");
      if (docker) {
        hosts?.setState(docker.id, "failed");
        return docker.id;
      }
      return null;
    });
  });

  await page.waitForTimeout(300);

  // Open Settings → Computers.
  await openSettings(page, "computers");
  await expect(page.getByTestId("computers-section")).toBeVisible();

  // Verify the guidance text.
  const guidance = page.getByTestId(`computer-guidance-${profileId}`);
  await expect(guidance).toBeVisible({ timeout: 3000 });
  await expect(guidance).toContainText("Container not running");
  await expect(guidance).toContainText("Pantoken does not manage container lifecycle");
});
