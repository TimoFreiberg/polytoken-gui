import { expect, test } from "@playwright/test";
import { drive, gotoFresh, waitForSettledWorkBlocks } from "./helpers.js";

// The answer-result card (QnaResult) surfaces the Q&A the user filled in. Two bugs it
// must not regress: (1) it sat at the wide-track's left edge instead of inline with the
// reading measure; (2) it floated to the bottom of the work block — every new tool/text
// that streamed in after the answer shoved it further down. The `answercard` fixture
// asks via the answer tool, then keeps working, so a settled turn has the card pinned
// between a pre-answer and a post-answer work run.
//
// This spec mocks the WIRE, not the answer extension. The `answercard`
// fixture (server/src/fixtures.ts) drives a canned `answer` toolSpan whose output is the
// extension's `formatQnA` text — the client-side QnaResult parses that wire text into the
// card. This spec stays the card-rendering guard.
test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
  await drive(page, "answercard");
  // greeting (1 run) + answercard's two runs (pre/post the answer) = 3 settled blocks.
  await waitForSettledWorkBlocks(page, 3);
});

test("the answer card shows the submitted Q&A", async ({ page }) => {
  const card = page.locator(".qna-result");
  await expect(card).toBeVisible();
  await expect(card.getByText("Your answers")).toBeVisible();
  await expect(
    card.getByText("How do you want to proceed with removing the unused-pkg", { exact: false }),
  ).toBeVisible();
  await expect(
    card.getByText("Drop the line from server/package.json", { exact: false }),
  ).toBeVisible();
});

test("the card stays pinned in chronological place, not floated to the bottom", async ({
  page,
}) => {
  const card = await page.locator(".qna-result").boundingBox();
  expect(card).not.toBeNull();

  // The answercard turn has two work runs: one BEFORE the answer, one AFTER. The card
  // must sit between them — a toggle above it AND a toggle below it.
  const toggles = page.getByTestId("work-toggle");
  const boxes = await Promise.all(
    (await toggles.all()).map((t) => t.boundingBox()),
  );
  const ys = boxes.map((b) => b!.y);
  expect(ys.some((y) => y < card!.y)).toBe(true); // pre-answer run above
  expect(ys.some((y) => y > card!.y)).toBe(true); // post-answer run below
});

test("the card is inline with the reading measure, not hugging the wide-track left", async ({
  page,
}) => {
  const card = await page.locator(".qna-result").boundingBox();
  // The turn-final response paragraph sits at the centered measure. The card's left
  // edge must match it (a few px tolerance), not sit to its left in the wide gutter.
  const response = await page
    .getByText("dep dropped, lockfile regenerated", { exact: false })
    .boundingBox();
  expect(card).not.toBeNull();
  expect(response).not.toBeNull();
  expect(Math.abs(card!.x - response!.x)).toBeLessThanOrEqual(2);
});
