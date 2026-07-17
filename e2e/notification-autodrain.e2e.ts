import { expect, test } from "@playwright/test";
import { gotoFresh, openSettings } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("notification autodrain toggle flips in Settings", async ({ page }) => {
  await openSettings(page, "notifications");
  const toggle = page.getByTestId("notification-autodrain");

  // Default: off (the mock seeds notificationAutodrain: false).
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(toggle).toContainText("Off");

  // Toggle on.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(toggle).toContainText("On");
  // Info notice appears in the transcript (last notice = most recent action).
  await expect(page.locator(".row.notice .ntext").last()).toContainText(
    "Notification auto-drain enabled",
  );

  // Toggle back off.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(toggle).toContainText("Off");
  // Info notice appears in the transcript (last notice = most recent action).
  await expect(page.locator(".row.notice .ntext").last()).toContainText(
    "Notification auto-drain disabled",
  );
});
