import { expect, test } from "@playwright/test";
import { drive, gotoFresh, openSidebar } from "./helpers.js";

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
  const time = demoRow.locator(".row-time");

  // AC.1 — On desktop the timestamp is hidden by default (opacity: 0), so idle rows
  // stay clean and the spinner stands out. Playwright treats opacity:0 elements as
  // "visible" (they have layout), so assert the computed opacity directly.
  await expect(time).toHaveCSS("opacity", "0");

  // AC.2 — Hovering the row reveals the compact timestamp to the left of the ⋯ button.
  // An idle (read) session resolves to "5m", "2h", "3d" — no " ago" suffix.
  await demoRow.hover();
  await expect(time).toHaveCSS("opacity", "1");
  await expect(time).toHaveText(/^\d+(m|h|d|w|mo|y)$/);

  // AC.7 — The timestamp carries a long-form "Last activity …" native tooltip.
  await expect(time).toHaveAttribute("title", /Last activity/);
});

test("the old second meta line is gone — no msg-count or activity sub-line", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  // demo-session used to render "3 msg" and a progress sub-line. The single-line redesign
  // drops both to give the title the full row width.
  const demoRow = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Wire up the WebSocket" });
  await expect(demoRow.locator(".msg-count")).toHaveCount(0);
  await expect(demoRow.locator(".activity")).toHaveCount(0);
});

test("the context ring only appears once a session crosses the fill threshold", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  // demo-session sits at 24% (MOCK_USAGE) — below the threshold, so its row stays clean.
  await expect(
    sidebar
      .locator(".row-wrap")
      .filter({ hasText: "Wire up the WebSocket" })
      .locator(".meter"),
  ).toHaveCount(0);

  // older-session is at 82% (MOCK_USAGE_HIGH) — over the threshold, so it lights up the
  // gauge in its accent (hot) band as a quiet "getting full" cue.
  const olderRing = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Explore the fold reducer" })
    .locator(".meter");
  await expect(olderRing).toBeVisible();
  await expect(olderRing).toHaveClass(/\baccent\b/);
});

test("an unread session marks the left gutter and keeps its timestamp on the right", async ({
  page,
}) => {
  await openSidebar(page);
  const row = page
    .getByTestId("sidebar")
    .locator(".row-wrap")
    .filter({ hasText: "Explore the fold reducer" });
  const status = row.getByTestId("session-status");

  // Drive a background turn to completion, then reset the mock: the server clears the
  // "done" attention phase while the client keeps the session flagged unread — landing in
  // the plain unread state.
  await drive(page, "bgrun");
  await expect(status).toHaveAttribute("data-state", "done");
  await page.request.get("/debug/reset");
  await expect(status).toHaveAttribute("data-state", "unread");

  // Unread shows as a dot in the LEFT gutter (not the right slot)…
  await expect(row.locator(".lead .unread-dot")).toBeVisible();
  // …and — unlike the other status states — the row keeps the compact timestamp (now in
  // .row-time, hover-revealed on desktop), since the unread cue has moved to the gutter.
  await row.hover();
  await expect(row.locator(".row-time")).toHaveText(/^(\d+(m|h|d|w|mo|y)|now)$/);
});
