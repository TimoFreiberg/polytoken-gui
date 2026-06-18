import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("a pending approval survives a reload (snapshot-on-reconnect)", async ({
  page,
}) => {
  await drive(page, "confirm");
  await expect(
    page.getByRole("dialog").getByText("Run destructive command?"),
  ).toBeVisible();

  // reload WITHOUT resetting the server — a fresh client should catch up
  await page.reload();
  await page.goto("/?dev");

  await expect(
    page.getByRole("dialog").getByText("Run destructive command?"),
  ).toBeVisible();
});

test("transcript survives a reload", async ({ page }) => {
  await drive(page, "reply");
  await expect(
    page.getByText("Show me the streamed reply script."),
  ).toBeVisible();
  await page.goto("/?dev");
  await expect(
    page.getByText("Show me the streamed reply script."),
  ).toBeVisible();
});
