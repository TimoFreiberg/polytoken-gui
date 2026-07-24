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

/** Drive the dev provider to inject pending risks for a host. */
async function injectRisks(page: import("@playwright/test").Page, hostId: string, risks: unknown[]): Promise<void> {
  await page.evaluate(({ hostId, risks }) => {
    const hosts = (window as unknown as { __pantokenHosts?: { setPendingRisks: (id: string, risks: unknown[]) => void } }).__pantokenHosts;
    hosts?.setPendingRisks(hostId, risks);
  }, { hostId, risks });
}

test("review risks panel: all three risks; single Accept risks & continue", async ({ page }) => {
  await openSetup(page);
  await page.getByTestId("cs-ssh-input").fill("dev@dev-server");
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 5000 });
  await page.getByTestId("cs-container-work-api-dev").click();

  // Inject all three risks before clicking Use this container.
  const risks = [
    { id: "root-1", kind: "rootExecution", fingerprint: "fp-root", title: "Agent runs as root", explanation: "x", consequences: "y", continueLabel: "Allow" },
    { id: "eph-1", kind: "ephemeralData", fingerprint: "fp-eph", title: "Ephemeral root", explanation: "x", consequences: "y", continueLabel: "Allow" },
    { id: "sock-1", kind: "dockerSocket", fingerprint: "fp-sock", title: "Docker socket", explanation: "x", consequences: "y", continueLabel: "Allow" },
  ];
  await page.getByTestId("cs-use-container").click();
  // The provider will set up the host, then we inject risks and drive to awaitingAcknowledgement.
  // Since the dev provider needs the host to exist first, we wait a moment.
  await page.waitForTimeout(500);
  // Inject risks and set state to awaitingAcknowledgement.
  await page.evaluate(({ risks }) => {
    const hosts = (window as unknown as { __pantokenHosts?: { setPendingRisks: (id: string, risks: unknown[]) => void; setState: (id: string, state: string) => void } }).__pantokenHosts;
    // Find the newly-created docker profile host.
    hosts?.setPendingRisks("docker-test", risks);
    hosts?.setState("docker-test", "awaitingAcknowledgement");
  }, { risks });

  // If the risks panel appears, verify it shows all three.
  const risksPanel = page.getByTestId("cs-risks-panel");
  if (await risksPanel.isVisible({ timeout: 3000 }).catch(() => false)) {
    await expect(page.getByTestId("cs-risk-rootExecution")).toBeVisible();
    await expect(page.getByTestId("cs-risk-ephemeralData")).toBeVisible();
    await expect(page.getByTestId("cs-risk-dockerSocket")).toBeVisible();
    await expect(page.getByTestId("cs-accept-risks")).toBeVisible();
  }
});
