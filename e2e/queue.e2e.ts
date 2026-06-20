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
