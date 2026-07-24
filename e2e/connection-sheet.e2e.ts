import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
  await openSidebar(page);
});

/** Drive the dev-remote host state via window.__pantokenHosts. */
async function setState(page: import("@playwright/test").Page, state: string): Promise<void> {
  await page.evaluate(
    (s) => (window as unknown as { __pantokenHosts?: { setState: (id: string, state: string) => void } }).__pantokenHosts?.setState("dev-remote", s),
    state,
  );
}

async function setFailure(page: import("@playwright/test").Page, label: string, action?: string, detail?: string): Promise<void> {
  await page.evaluate(
    (args: [string, string?, string?]) => {
      const w = window as unknown as { __pantokenHosts?: { setFailure: (id: string, l: string, a?: string, d?: string) => void } };
      w.__pantokenHosts?.setFailure("dev-remote", args[0], args[1], args[2]);
    },
    [label, action, detail] as [string, string?, string?],
  );
}

test("First-time connection shows four-step progress", async ({ page }) => {
  // Open the host switcher and select the remote host.
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await page.getByTestId("host-option-dev-remote").click();

  // The connection sheet should appear (host is in testingSsh after connectHost).
  // The dev provider's connectHost sets testingSsh and blocks until externally driven.
  await expect(page.getByTestId("connection-sheet-panel")).toBeVisible({ timeout: 10000 });
  // Drive to provisioning to advance past testingSsh.
  await setState(page, "provisioning");

  // Four steps should be visible.
  await expect(page.getByTestId("connection-steps")).toBeVisible();
  for (let i = 0; i < 4; i++) {
    await expect(page.getByTestId(`connection-step-${i}`)).toBeVisible();
  }
  // Labels: SSH connection, Remote system, Polytoken compatibility, Pantoken runtime.
  await expect(page.getByTestId("connection-steps")).toContainText("SSH connection");
  await expect(page.getByTestId("connection-steps")).toContainText("Pantoken runtime");
});

test("Driving to ready closes the sheet", async ({ page }) => {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await page.getByTestId("host-option-dev-remote").click();
  await expect(page.getByTestId("connection-sheet-panel")).toBeVisible({ timeout: 10000 });

  await setState(page, "ready");
  await expect(page.getByTestId("connection-sheet-panel")).toBeHidden({ timeout: 10000 });
});

test("Driving to failed shows failure UI with Retry/Edit/Cancel", async ({ page }) => {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await page.getByTestId("host-option-dev-remote").click();
  await expect(page.getByTestId("connection-sheet-panel")).toBeVisible({ timeout: 10000 });

  await setFailure(page, "SSH authentication failed", "Check your SSH key is loaded in the agent", "ssh: auth method none succeeded");

  await expect(page.getByTestId("failure-section")).toBeVisible();
  await expect(page.getByTestId("failure-section")).toContainText("SSH authentication failed");
  await expect(page.getByTestId("failure-retry")).toBeVisible();
  await expect(page.getByTestId("failure-edit")).toBeVisible();
  await expect(page.getByTestId("failure-dismiss")).toBeVisible();

  // Failure detail should be behind a disclosure (collapsed by default).
  await expect(page.getByTestId("failure-detail")).toBeHidden();
  // Expand the detail disclosure.
  await page.locator(".detail-toggle").click();
  await expect(page.getByTestId("failure-detail")).toBeVisible();
});

test("Cancel during connecting cancels the connection and closes the sheet", async ({ page }) => {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await page.getByTestId("host-option-dev-remote").click();
  await expect(page.getByTestId("connection-sheet-panel")).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("connection-cancel")).toBeVisible();

  await page.getByTestId("connection-cancel").click();
  await expect(page.getByTestId("connection-sheet-panel")).toBeHidden({ timeout: 10000 });
});

test("Reconnecting an already-connected host is non-modal (no sheet)", async ({ page }) => {
  // First, connect the host to ready (establishing everConnected).
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await page.getByTestId("host-option-dev-remote").click();
  await expect(page.getByTestId("connection-sheet-panel")).toBeVisible({ timeout: 10000 });
  await setState(page, "ready");
  await expect(page.getByTestId("connection-sheet-panel")).toBeHidden({ timeout: 10000 });

  // Now drive to reconnecting — the sheet should NOT appear.
  await setState(page, "reconnecting");
  await page.waitForTimeout(300);
  await expect(page.getByTestId("connection-sheet-panel")).toBeHidden();
});
