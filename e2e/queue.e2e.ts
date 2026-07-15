import { expect, test } from "@playwright/test";
import { drive, gotoFresh, openSidebar } from "./helpers.js";

const ACTIVE = "Wire up the WebSocket bridge";
const BG = "Explore the fold reducer";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("queued modes survive reconnect and session refocus", async ({ page }) => {
  await drive(page, "queue");
  const tray = page.getByTestId("queue-tray");
  await expect(tray).toContainText("Queued · 2");
  await expect(tray.locator('[data-mode="steer"]')).toContainText(
    "Please inspect the failing test first.",
  );
  await expect(tray.locator('[data-mode="followUp"]')).toContainText(
    "Then summarize the fix and remaining risks.",
  );

  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();
  await expect(page.getByTestId("queue-tray")).toHaveCount(0);
  await openSidebar(page);
  await page.getByTestId("sidebar").locator(".row", { hasText: ACTIVE }).click();
  await expect(page.getByTestId("queue-tray")).toContainText("Queued · 2");

  await page.reload();
  await expect(page.getByTestId("queue-tray")).toContainText("Queued · 2");

  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");
  await sidebar.locator(".row", { hasText: BG }).click();
  await expect(page.getByTestId("queue-tray")).toHaveCount(0);
  await sidebar.locator(".row", { hasText: ACTIVE }).click();
  await expect(page.getByTestId("queue-tray")).toContainText("Queued · 2");
});

test("delivery removes one queued row and starts its user turn", async ({ page }) => {
  await drive(page, "queue");
  await drive(page, "deliverqueue");

  const tray = page.getByTestId("queue-tray");
  await expect(tray).toContainText("Queued · 1");
  await expect(tray).not.toContainText("Please inspect the failing test first.");
  await expect(
    page.locator(".row.user", {
      hasText: "Please inspect the failing test first.",
    }),
  ).toBeVisible();
});

test("Alt+Up restores all text to one editor and clears every client", async ({
  page,
  context,
}) => {
  await drive(page, "queue");
  const other = await context.newPage();
  await other.goto("/?dev");
  await expect(other.getByTestId("queue-tray")).toContainText("Queued · 2");

  const editor = page.locator("textarea");
  await editor.focus();
  await editor.press("Alt+ArrowUp");

  await expect(page.getByTestId("queue-tray")).toHaveCount(0);
  await expect(other.getByTestId("queue-tray")).toHaveCount(0);
  await expect(editor).toHaveValue(
    "Please inspect the failing test first.\n\nThen summarize the fix and remaining risks.",
  );
  await expect(other.locator("textarea")).toHaveValue("");
});

test("steer button aborts the current turn", async ({ page }) => {
  await drive(page, "streamhold");
  await drive(page, "queue");
  await expect(page.getByTestId("working-indicator")).toBeVisible();

  await page.getByTestId("steer-button").click();
  // Abort stops the turn — the working indicator disappears.
  await expect(page.getByTestId("working-indicator")).toHaveCount(0);
});

test("steer button is disabled while offline", async ({ page }) => {
  await drive(page, "streamhold");
  await drive(page, "queue");
  const steer = page.getByTestId("steer-button");
  await expect(steer).toBeEnabled();

  await page.evaluate(() =>
    window.dispatchEvent(new Event("pantoken:test-disconnect")),
  );
  await expect(steer).toBeDisabled();
});

test("steer button is disabled when no turn is active", async ({ page }) => {
  await drive(page, "queue");
  await expect(page.getByTestId("queue-tray")).toContainText("Queued · 2");
  // No streamhold — no active turn to abort.
  await expect(page.getByTestId("steer-button")).toBeDisabled();
});

test("edit button on a queued item restores all prompts to the composer", async ({
  page,
}) => {
  await drive(page, "queue");
  await expect(page.getByTestId("queue-tray")).toContainText("Queued · 2");

  const editor = page.locator("textarea");
  if ((await editor.inputValue()) !== "") await editor.fill("");
  await page.getByTestId("edit-queued").first().click();
  await expect(page.getByTestId("queue-tray")).toHaveCount(0);
  await expect(page.locator("textarea")).toHaveValue(
    "Please inspect the failing test first.\n\nThen summarize the fix and remaining risks.",
  );
});

test("plain Up-arrow restores queued prompts when the composer is empty", async ({
  page,
}) => {
  await drive(page, "queue");
  await expect(page.getByTestId("queue-tray")).toContainText("Queued · 2");

  const editor = page.locator("textarea");
  await editor.focus();
  // Ensure the composer is empty — the intercept only fires on an empty field.
  if ((await editor.inputValue()) !== "") await editor.fill("");
  await editor.press("ArrowUp");

  await expect(page.getByTestId("queue-tray")).toHaveCount(0);
  await expect(editor).toHaveValue(
    "Please inspect the failing test first.\n\nThen summarize the fix and remaining risks.",
  );
});
