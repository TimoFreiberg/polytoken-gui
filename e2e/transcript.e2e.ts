import { expect, test } from "@playwright/test";
import { drive, expandWork, gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("an extension compatibility issue folds into a warning notice", async ({
  page,
}) => {
  await drive(page, "compat");
  const notice = page.locator(".notice.warning");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('Extension capability "custom"');
  await expect(notice).toContainText("terminal-only");
});

test("renders the greeting conversation: user, collapsed work, final answer", async ({
  page,
}) => {
  // User prompt + the turn-final answer are always visible…
  await expect(
    page.getByText("Add a /health route to the server"),
  ).toBeVisible();
  await expect(page.getByText("Routes live in")).toBeVisible();
  // …but the working section (narration + tool) is collapsed behind "Worked for Ns".
  await expect(page.getByTestId("work-toggle")).toContainText("Worked for");
  await expect(
    page.getByText("I'll add a lightweight health endpoint"),
  ).toHaveCount(0);
  await expect(page.getByText("Run shell command")).toHaveCount(0);

  // Expanding reveals the narration and the tool card.
  await expandWork(page);
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
  await expandWork(page);
  await page.getByText("Run shell command").click();
  await expect(page.getByText("server/src/index.ts:14")).toBeVisible();
});

test("tool card expands to show the full arguments", async ({ page }) => {
  await expandWork(page);
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
