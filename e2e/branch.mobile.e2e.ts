import { expect, test } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

const PROMPT = "Add a /health route to the server and a smoke test for it.";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
  // Wait past the running window — the prompt's rewind handle backfills only once the
  // turn settles (see branch.e2e.ts). Rewinding is a no-op mid-turn. (The greeting's lone
  // answer is the active-path tip, so its "Rewind from here" is intentionally suppressed.)
  await expect(
    page.getByRole("button", { name: "Rewind to this prompt" }),
  ).toBeVisible();
});

// On a phone there's no hover, so the rewind affordance must be reachable without one
// (the desktop reveal-on-hover would otherwise leave it tappable-but-invisible).
test("rewind button is reachable on touch and rewinds the transcript", async ({
  page,
}) => {
  const branch = page.getByRole("button", { name: "Rewind to this prompt" });
  await expect(branch).toBeVisible();
  // Click-twice confirm gate: first tap arms, second tap fires the rewind.
  await branch.tap();
  await branch.tap();
  await expect(page.getByPlaceholder("Message pantoken…")).toHaveValue(PROMPT);
  await expect(page.getByText("Routes live in")).toHaveCount(0);
});
