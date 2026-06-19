import { expect, test } from "@playwright/test";
import { drive, expandWork, gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("a mixed run of mergeable tools collapses into one combined card", async ({
  page,
}) => {
  await drive(page, "search");
  // The search turn settles, so its working section collapses behind "Worked for Ns";
  // reveal it to reach the merged card.
  await expect(page.getByText("Reconnect lives in")).toBeVisible();
  await expandWork(page);

  // 2 reads + 2 greps + 1 find, uninterrupted, fold into ONE card. The header
  // shows the total count plus each distinct tool name once (first-appearance
  // order), not a per-name breakdown or one card per name.
  const head = page.locator(".merged-head");
  await expect(head).toHaveCount(1);
  await expect(head.locator(".count")).toHaveText("5 tools");
  await expect(head.locator(".tool-names")).toHaveText("(read, grep, find)");
});

test("merged card expands in two steps: the list, then each call", async ({
  page,
}) => {
  await drive(page, "search");
  await expect(page.getByText("Reconnect lives in")).toBeVisible();
  await expandWork(page);
  const card = page.locator(".merged-tools");

  // Step 0 — collapsed: no inner tool cards rendered yet.
  await expect(card.locator(".merged-body")).toHaveCount(0);

  // Step 1 — expand the card: the run shows as 5 collapsed ToolCards. Still no
  // output visible (each ToolCard owns its own inner expand state).
  await card.locator(".merged-head").click();
  const innerCards = card.locator(".merged-body .tool");
  await expect(innerCards).toHaveCount(5);
  await expect(card.locator(".merged-body .tool .out")).toHaveCount(0);

  // Step 2 — expand one inner ToolCard: its output appears.
  await innerCards.first().locator(".head").click();
  await expect(
    card.getByText("private reconnect()", { exact: false }),
  ).toBeVisible();
});
