import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("rows are a single line: title plus a compact last-activity timestamp", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  const demoRow = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Wire up the WebSocket" });

  // The title and the unified status/time slot share one line. An idle (read) session
  // resolves the slot to a compact timestamp — "5m", "2h", "3d" — no " ago" suffix.
  await expect(
    demoRow.getByTestId("session-status").locator(".time"),
  ).toHaveText(/^\d+(m|h|d|w|mo|y)$/);
});

test("the old second meta line is gone — no msg-count, activity, or context ring", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  // demo-session used to render "3 msg", a context ring, and a progress sub-line. The
  // single-line redesign drops all three to give the title the full row width.
  const demoRow = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Wire up the WebSocket" });
  await expect(demoRow.locator(".msg-count")).toHaveCount(0);
  await expect(demoRow.locator(".activity")).toHaveCount(0);
  await expect(demoRow.locator(".meter")).toHaveCount(0);
});
