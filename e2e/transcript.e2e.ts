import { expect, test } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("renders the greeting conversation: user, assistant, tool card", async ({
  page,
}) => {
  await expect(
    page.getByText("Add a /health route to the server"),
  ).toBeVisible();
  await expect(
    page.getByText("I'll add a lightweight health endpoint"),
  ).toBeVisible();
  await expect(page.getByText("Run shell command")).toBeVisible();
});

test("the composer footer shows the model; the header shows a live connection", async ({
  page,
}) => {
  // The model label lives in the composer footer now (moved out of the header).
  await expect(
    page
      .locator(".composer-wrap .mp .badge")
      .filter({ hasText: "Claude Opus 4.8" }),
  ).toBeVisible();
  await expect(
    page.locator(".hdr").getByText("live", { exact: true }),
  ).toBeVisible();
});

test("tool card expands to show output", async ({ page }) => {
  await page.getByText("Run shell command").click();
  await expect(page.getByText("server/src/index.ts:14")).toBeVisible();
});

test("tool card expands to show the full arguments", async ({ page }) => {
  await page.getByText("Run shell command").click();
  // The args block labels each input key and shows its full value in a <pre> —
  // the collapsed header only renders a truncated single-line preview.
  const args = page.locator(".tool .args");
  await expect(args.locator(".arg-key", { hasText: "command" })).toBeVisible();
  await expect(args.locator(".arg-val")).toContainText(
    'rg -n "app.get\\(" server/src',
  );
});

test("composer is present and idle", async ({ page }) => {
  await expect(page.getByPlaceholder("Message pilot…")).toBeVisible();
});
