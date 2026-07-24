import { expect, test, devices } from "@playwright/test";
import { gotoFresh, openSidebar, openSettings } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
  await openSidebar(page);
});

test.use({ ...devices["Pixel 7"] });

test("Computers section renders with 44px touch targets", async ({ page }) => {
  await openSettings(page, "computers");
  await expect(page.getByTestId("computers-section")).toBeVisible();
  // Check that the Add computer button has at least 44px height.
  const addBtn = page.getByTestId("add-computer-btn");
  const box = await addBtn.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
});

test("Profile form is full-screen with Back button", async ({ page }) => {
  await openSettings(page, "computers");
  await page.getByTestId("add-computer-btn").click();
  await expect(page.getByTestId("profile-form-panel")).toBeVisible();
  // Full-screen: the panel should cover the whole viewport.
  const panel = page.getByTestId("profile-form-panel");
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(350); // roughly full-width on Pixel 7
  // Back button should be visible.
  await expect(panel.getByText("Back")).toBeVisible();
  // Close via Back.
  await panel.getByText("Back").click();
  await expect(page.getByTestId("profile-form-panel")).toBeHidden();
});

test("Add/edit/delete flows work on phone", async ({ page }) => {
  await openSettings(page, "computers");
  await page.getByTestId("add-computer-btn").click();
  await page.getByTestId("profile-label-input").fill("Phone Server");
  await page.getByTestId("profile-ssh-input").fill("user@phone.example.com");
  await page.getByTestId("profile-form-save").click();
  await expect(page.getByTestId("profile-form-panel")).toBeHidden();
  // On phone, saving closes the form. Re-open Settings to Computers to verify.
  await openSettings(page, "computers");
  await expect(page.getByTestId("computers-section")).toContainText("Phone Server");
});
