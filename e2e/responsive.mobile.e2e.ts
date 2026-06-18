import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

// Runs under the "mobile" project (iPhone 13 viewport).
test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("transcript and composer fit the mobile viewport", async ({ page }) => {
  await expect(
    page.getByText("Add a /health route to the server"),
  ).toBeVisible();
  await expect(page.getByPlaceholder("Message pilot…")).toBeVisible();
});

test("approval sheet is reachable and tappable on mobile", async ({ page }) => {
  await drive(page, "confirm");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Run destructive command?")).toBeVisible();
  const allow = dialog.getByRole("button", { name: "Allow" });
  await expect(allow).toBeInViewport();
  await allow.click();
  await expect(page.getByText("Approved — continuing.")).toBeVisible();
});
