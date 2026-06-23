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

test("a mixed run including bash collapses into one tool-styled summary", async ({
  page,
}) => {
  await drive(page, "search");
  // The search turn settles, so its working section collapses behind "Worked for Ns";
  // reveal it to reach the merged card.
  await expect(page.getByText("Reconnect lives in")).toBeVisible();
  await expandWork(page);

  // 2 reads + 2 greps + 1 find + 1 bash, uninterrupted, fold into ONE subdued row. The
  // label is a programmatic prose summary: tools grouped by category (grep+find both read
  // as "searches") in first-appearance order, counted, with the sentence capitalized. A
  // settled-ok run shows no status dot — it's meant to recede into ambient noise.
  const summary = page.locator(".tool.summary");
  const head = summary.locator(".head");
  await expect(summary).toHaveClass(/ok/);
  await expect(head).toHaveCount(1);
  await expect(head.locator(".label")).toHaveText(
    "Read 2 files, ran 3 searches, ran a command",
  );
  await expect(head.locator(".status")).toHaveCount(0);
});

test("a skill load (read of a SKILL.md) is labelled as such in the summary", async ({
  page,
}) => {
  await drive(page, "skill");
  await expect(page.getByText("The reducer is fine")).toBeVisible();
  // Wait for BOTH the greeting and the skill turn to settle before expanding: the final
  // text appears mid-stream, so without this `expandWork` races and expands the only
  // already-collapsed block (the greeting) instead of the skill turn.
  await waitForSettledWorkBlocks(page, 2);
  await expandWork(page);

  // The skill-loading read + a normal read + a bash fold into one row whose prose names
  // the loaded skill instead of counting it as a plain file read. Scope to THIS turn's
  // work block: the greeting turn also renders a tool summary, so an unscoped
  // `.tool.summary` could match both and trip strict mode.
  const summary = page
    .locator(".turn-work")
    .last()
    .getByTestId("work-body")
    .locator(".tool.summary");
  await expect(summary.locator(".head .label")).toHaveText(
    "Loaded skill debug, read a file, ran a command",
  );
});

test("merged card expands in two steps: the list, then each call", async ({
  page,
}) => {
  await drive(page, "search");
  await expect(page.getByText("Reconnect lives in")).toBeVisible();
  await expandWork(page);
  const card = page.locator(".tool.summary");

  // Step 0 — collapsed: no inner tool cards rendered yet.
  await expect(card.locator(".body")).toHaveCount(0);

  // Step 1 — expand the card: the run shows as 6 collapsed ToolCards. Still no
  // output visible (each ToolCard owns its own inner expand state).
  await card.locator(":scope > .head").click();
  const innerCards = card.locator(":scope > .body > .tool");
  await expect(innerCards).toHaveCount(6);
  await expect(card.locator(":scope > .body > .tool .out")).toHaveCount(0);

  // The nested calls render FLAT (no per-card box) so successive calls read as a tight
  // list, not a stack of bordered cards. Guard the chrome-removal so it can't regress.
  await expect(innerCards.first()).toHaveClass(/\bflat\b/);
  const borderTop = await innerCards
    .first()
    .evaluate((el) => getComputedStyle(el).borderTopWidth);
  expect(borderTop).toBe("0px");

  // Step 2 — expand one inner ToolCard: its output appears.
  await innerCards.first().locator(".head").click();
  await expect(
    card.getByText("private reconnect()", { exact: false }),
  ).toBeVisible();
});
