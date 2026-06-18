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

test("status header shows model and a live connection", async ({ page }) => {
  await expect(page.getByText("Claude Opus 4.8")).toBeVisible();
  await expect(page.getByText("live", { exact: true })).toBeVisible();
});

test("tool card expands to show output", async ({ page }) => {
  await page.getByText("Run shell command").click();
  await expect(page.getByText("server/src/index.ts:14")).toBeVisible();
});

test("composer is present and idle", async ({ page }) => {
  await expect(page.getByPlaceholder("Message pilot…")).toBeVisible();
});
