import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("goal card renders as a blocking dialog with title + message", async ({
  page,
}) => {
  await drive(page, "goal");
  const dialog = page.getByRole("dialog", { name: "Ship feature X" });
  await expect(dialog).toBeVisible();
  // The proposed summary renders as the message body (AC.1).
  await expect(dialog.getByText("Implement the new dashboard widget")).toBeVisible();
  // The dialog is blocking — a scrim/backdrop is present (AC.1).
  await expect(dialog).toHaveAttribute("aria-modal", "true");
});

test("clicking Allow resolves the goal card", async ({ page }) => {
  await drive(page, "goal");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Allow" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Approved — continuing.")).toBeVisible();
});

test("Escape cancels the goal card (deny-safe)", async ({ page }) => {
  await drive(page, "goal");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Dialog cancelled.")).toBeVisible();
});

test("unknown interrogative type renders an error card with Dismiss", async ({
  page,
}) => {
  await drive(page, "unknown");
  const dialog = page.getByRole("dialog", {
    name: "⚠ Unknown request type: some_future_type",
  });
  await expect(dialog).toBeVisible();
  // The dialog is blocking (AC.4).
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  // Either button dismisses it — both produce {kind:"cancel"} via case "unknown".
  await dialog.getByRole("button", { name: "Deny" }).click();
  await expect(dialog).toBeHidden();
});

test("unknown interrogative: Escape dismisses the error card", async ({
  page,
}) => {
  await drive(page, "unknown");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Dialog cancelled.")).toBeVisible();
});
