import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("sidebar rows count the operator's own messages, not tool/agent traffic", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  // demo-session's fixture has userMessageCount: 3 — the human turns, not a raw
  // message count inflated by assistant + toolResult entries.
  const demoRow = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Wire up the WebSocket" });
  await expect(demoRow.locator(".msg-count")).toHaveText(/^3 msg/);
});

test("loaded sessions show a color-coded context ring; others show none", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  // demo-session carries MOCK_USAGE (24%) → green/ok band.
  const demoRing = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Wire up the WebSocket" })
    .locator(".meta .meter");
  await expect(demoRing).toBeVisible();
  await expect(demoRing).toHaveClass(/\bok\b/);
  await expect(demoRing).toHaveAttribute(
    "title",
    /47,200 \/ 200,000 tokens in context/,
  );

  // older-session carries MOCK_USAGE_HIGH (82%) → dark-orange/accent band.
  const olderRing = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Explore the fold reducer" })
    .locator(".meta .meter");
  await expect(olderRing).toHaveClass(/\baccent\b/);

  // scratch-session has no usage (it isn't loaded) → no ring at all.
  const scratchRow = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "quick scratch session" });
  await expect(scratchRow.locator(".meta .meter")).toHaveCount(0);
});
