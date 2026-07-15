import { expect, test } from "@playwright/test";
import {
  drive,
  expandWork,
  gotoFresh,
  waitForSettledWorkBlocks,
} from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("a mixed run of tools each renders as its own card (no prose summary)", async ({
  page,
}) => {
  await drive(page, "search");
  // The search turn settles, so its working section collapses behind "Worked for Ns";
  // reveal it to reach the tool cards.
  await expect(page.getByText("Reconnect lives in")).toBeVisible();
  await expandWork(page);

  // 2 reads + 2 greps + 1 find + 1 bash = 6 individual tool cards, each standalone.
  // No prose summary row — each tool is its own expandable card.
  const work = page.getByTestId("work-body").last();
  const cards = work.locator(":scope > .tool");
  await expect(cards).toHaveCount(6);
  // Each card carries its own header + status (settled-ok shows no error dot).
  const okCards = work.locator(":scope > .tool.ok");
  await expect(okCards).toHaveCount(6);
  await expect(okCards.locator(":scope > .head > .status")).toHaveCount(0);
  await expect(okCards.first().locator(":scope > .head")).toHaveAccessibleName(
    /completed/,
  );
  // No summary rows exist anymore.
  await expect(work.locator(":scope > .tool.summary")).toHaveCount(0);
});

test("a skill load (read of a SKILL.md) renders as its own card, not a prose label", async ({
  page,
}) => {
  await drive(page, "skill");
  await expect(page.getByText("The reducer is fine")).toBeVisible();
  // Wait for BOTH the greeting and the skill turn to settle before expanding: the final
  // text appears mid-stream, so without this `expandWork` races and expands the only
  // already-collapsed block (the greeting) instead of the skill turn.
  await waitForSettledWorkBlocks(page, 2);
  await expandWork(page);

  // The skill-loading read is just another tool card — no prose "loaded skill" label.
  // Scope to THIS turn's work block: the greeting turn also renders tool cards.
  const work = page.locator(".turn-work").last().getByTestId("work-body");
  const cards = work.locator(":scope > .tool");
  await expect(cards).toHaveCount(3); // SKILL.md read + a normal read + a bash
  await expect(work.locator(":scope > .tool.summary")).toHaveCount(0);
});

test("each tool card expands independently to show its output", async ({
  page,
}) => {
  await drive(page, "search");
  await expect(page.getByText("Reconnect lives in")).toBeVisible();
  await expandWork(page);
  const work = page.getByTestId("work-body").last();
  const cards = work.locator(":scope > .tool");

  // Step 0 — all collapsed: no inner output visible yet.
  await expect(cards.first().locator(":scope > .body")).toHaveCount(0);

  // Step 1 — expand one ToolCard: its output appears.
  await cards.first().locator(":scope > .head").click();
  await expect(cards.first().locator(":scope > .body")).toBeVisible();
  await expect(
    cards.first().getByText("private reconnect()", { exact: false }),
  ).toBeVisible();

  // Other cards stay collapsed.
  await expect(cards.nth(1).locator(":scope > .body")).toHaveCount(0);
});
