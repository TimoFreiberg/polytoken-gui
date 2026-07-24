import { expect, test } from "@playwright/test";
import { gotoFresh, openSettings, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
  await openSidebar(page);
});

test("Add computer button opens profile form", async ({ page }) => {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("add-computer-btn").click();
  await expect(page.getByTestId("profile-form-panel")).toBeVisible();
  await expect(page.getByTestId("profile-label-input")).toBeVisible();
});

test("Manage computers opens Settings to Computers section", async ({ page }) => {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("manage-computers-btn").click();
  await expect(page.getByTestId("settings-panel")).toBeVisible();
  await expect(page.getByTestId("computers-section")).toBeVisible();
});

test("Computers section shows local computer", async ({ page }) => {
  await openSettings(page, "computers");
  await expect(page.getByTestId("computers-section")).toBeVisible();
  // The local computer row should show "Dev computer" label and "Connected" state.
  await expect(page.getByTestId("computers-section")).toContainText("Connected");
});

test("Filling the form and saving adds a profile to the list", async ({ page }) => {
  await openSettings(page, "computers");
  await page.getByTestId("add-computer-btn").click();
  await page.getByTestId("profile-label-input").fill("Test Server");
  await page.getByTestId("profile-ssh-input").fill("user@test.example.com");
  await page.getByTestId("profile-form-save").click();
  await expect(page.getByTestId("profile-form-panel")).toBeHidden();
  // The profile should appear in the Computers section.
  await expect(page.getByTestId("computers-section")).toContainText("Test Server");
  await expect(page.getByTestId("computers-section")).toContainText("test.example.com");
});

test("Form validation shows errors inline and preserves values", async ({ page }) => {
  await openSettings(page, "computers");
  await page.getByTestId("add-computer-btn").click();
  // Submit with empty fields.
  await page.getByTestId("profile-form-save").click();
  await expect(page.getByTestId("profile-form-error")).toBeVisible();
  await expect(page.getByTestId("profile-form-error")).toContainText("Name is required");
  // Fill name only, still missing SSH destination.
  await page.getByTestId("profile-label-input").fill("My Server");
  await page.getByTestId("profile-form-save").click();
  await expect(page.getByTestId("profile-form-error")).toContainText("SSH destination is required");
  // The name should be preserved.
  await expect(page.getByTestId("profile-label-input")).toHaveValue("My Server");
});

test("Edit opens the form pre-filled with the profile's values", async ({ page }) => {
  await openSettings(page, "computers");
  await page.getByTestId("add-computer-btn").click();
  await page.getByTestId("profile-label-input").fill("Edit Me");
  await page.getByTestId("profile-ssh-input").fill("user@edit.example.com");
  await page.getByTestId("profile-form-save").click();
  await expect(page.getByTestId("profile-form-panel")).toBeHidden();

  // Click Edit on the profile.
  const row = page.locator("[data-testid^='computer-row-']").filter({ hasText: "Edit Me" });
  await row.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByTestId("profile-form-panel")).toBeVisible();
  await expect(page.getByTestId("profile-label-input")).toHaveValue("Edit Me");
  await expect(page.getByTestId("profile-ssh-input")).toHaveValue("user@edit.example.com");
});

test("Remove shows a confirmation, then removes the profile", async ({ page }) => {
  await openSettings(page, "computers");
  await page.getByTestId("add-computer-btn").click();
  await page.getByTestId("profile-label-input").fill("Remove Me");
  await page.getByTestId("profile-ssh-input").fill("user@remove.example.com");
  await page.getByTestId("profile-form-save").click();
  await expect(page.getByTestId("profile-form-panel")).toBeHidden();

  const row = page.locator("[data-testid^='computer-row-']").filter({ hasText: "Remove Me" });
  await row.getByRole("button", { name: "Remove" }).click();
  // Confirmation should appear.
  await expect(page.locator("[data-testid^='delete-confirm-']")).toBeVisible();
  await page.locator("[data-testid^='delete-confirm-']").getByRole("button", { name: "Remove" }).click();

  // The profile should be gone.
  await expect(page.getByTestId("computers-section")).not.toContainText("Remove Me");
});

test("No secret fields in form", async ({ page }) => {
  await openSettings(page, "computers");
  await page.getByTestId("add-computer-btn").click();
  // Verify the credential note is present.
  await expect(page.getByText("does not store passwords or private keys")).toBeVisible();
  // Verify no password/key/passphrase inputs exist.
  const inputs = page.getByTestId("profile-form-panel").locator("input");
  const count = await inputs.count();
  for (let i = 0; i < count; i++) {
    const type = await inputs.nth(i).getAttribute("type");
    expect(type).not.toBe("password");
  }
});
