import { expect, test } from "@playwright/test";
import { gotoFresh, waitForSettledWorkBlocks } from "./helpers.js";

const PROMPT = "Add a /health route to the server and a smoke test for it.";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
  // Settle proxy: the prompt's "Rewind to this prompt" handle backfills at the SAME
  // turn boundary as the answer's entry id, so waiting on it guarantees we're past the
  // running window (rewinding is a no-op mid-turn). We can't wait on "Rewind from here"
  // here anymore — the greeting's lone answer IS the active-path tip, so its button is
  // intentionally suppressed (rewinding from the tip would be a no-op).
  await expect(
    page.getByRole("button", { name: "Rewind to this prompt" }),
  ).toBeVisible();
});

test("the leaf answer hides 'Rewind from here'; the prompt still offers re-edit", async ({
  page,
}) => {
  // The greeting prompt is re-editable…
  await expect(
    page.getByRole("button", { name: "Rewind to this prompt" }),
  ).toBeVisible();
  // …but its answer is the current tip, so "continue on a new path from here" is a
  // no-op and the button is gone.
  await expect(
    page.getByRole("button", { name: "Rewind from here" }),
  ).toHaveCount(0);
});

test("an earlier turn's answer offers 'Rewind from here' once it's no longer the tip", async ({
  page,
}) => {
  // Send a second prompt so the greeting's answer stops being the active-path tip.
  const box = page.getByPlaceholder("Message pilot…");
  await box.fill("now make it return JSON");
  await box.press("Enter");
  await waitForSettledWorkBlocks(page, 2);

  // Exactly one "Rewind from here": on the greeting (now non-leaf) turn. The new turn's
  // answer is the tip, so it stays suppressed.
  const branch = page.getByRole("button", { name: "Rewind from here" });
  await expect(branch).toHaveCount(1);

  // Position check defeats an inverted gate (which would also yield count 1, but on the
  // leaf): the surviving button must sit ABOVE the second prompt, i.e. on the older turn.
  const branchBox = await branch.boundingBox();
  const secondPromptBox = await page
    .getByText("now make it return JSON")
    .boundingBox();
  expect(branchBox).not.toBeNull();
  expect(secondPromptBox).not.toBeNull();
  expect(branchBox!.y).toBeLessThan(secondPromptBox!.y);
});

test("rewinding from a user prompt rewinds the transcript and prefills the composer", async ({
  page,
}) => {
  const btn = page.getByRole("button", { name: "Rewind to this prompt" });
  // Click-twice confirm gate: first click arms, second click fires the rewind.
  await btn.click();
  await btn.click();

  // The re-edit gesture: the prompt text comes back in the composer…
  await expect(page.getByPlaceholder("Message pilot…")).toHaveValue(PROMPT);
  // …and the rewind dropped the old turn, so the answer is gone.
  await expect(page.getByText("Routes live in")).toHaveCount(0);
  await expect(page.getByText("No messages yet")).toBeVisible();
});

test("Cmd/Ctrl+Shift+↑ rewinds from the last prompt", async ({ page }) => {
  // The hotkey bypasses the click-twice confirm gate (it's a deliberate keyboard gesture).
  await page.keyboard.press("Control+Shift+ArrowUp");
  await expect(page.getByPlaceholder("Message pilot…")).toHaveValue(PROMPT);
  await expect(page.getByText("Routes live in")).toHaveCount(0);
});
