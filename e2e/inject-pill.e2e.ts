import { expect, test } from "@playwright/test";
import { drive, expandWork, gotoFresh, waitForSettledWorkBlocks } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

// An extension nudge (the daemon's sendMessage, e.g. extension-nudge) triggers a fresh run with
// no user prompt. It remains in the same outer turn, but the injected pill and the prior
// assistant response now fold INTO the collapsed "Worked for Ns" work block — only the
// turn-final response stays visible without expanding.
test("an extension nudge folds the prior response into the work block and keeps the final response visible", async ({
  page,
}) => {
  await drive(page, "inject");
  await waitForSettledWorkBlocks(page, 2);

  // The nudge run's own response (after the followup call) is the turn-final
  // assistant message — it stays visible WITHOUT expanding any work block.
  await expect(
    page.getByText("staged a followup note", { exact: false }),
  ).toBeVisible();

  // The prior assistant response ("renamed…") and the injected nudge pill now
  // fold into the collapsed work block. Expand it to reveal them.
  await expandWork(page);

  // The prior response renders inside the expanded work block.
  await expect(page.getByText("renamed", { exact: false })).toBeVisible();

  // The injected nudge renders as a tiny collapsed pill labelled by its customType…
  const pill = page.locator(".inject-pill");
  await expect(pill).toBeVisible();
  await expect(pill).toContainText("extension-nudge");

  // …whose body is hidden until expanded, and never shows the raw XML wrapper.
  await expect(page.locator(".inject-body")).toHaveCount(0);
});

test("expanding the nudge pill reveals the de-wrapped note text", async ({
  page,
}) => {
  await drive(page, "inject");
  await waitForSettledWorkBlocks(page, 2);

  // The pill is inside the collapsed work block — expand it first.
  await expandWork(page);

  const pill = page.locator(".inject-pill");
  await expect(pill).toBeVisible();
  await expect(pill).toHaveAttribute("aria-expanded", "false");
  await pill.click();
  await expect(pill).toHaveAttribute("aria-expanded", "true");

  const body = page.locator(".inject-body");
  await expect(body).toBeVisible();
  // The outer <extension-nudge> wrapper is stripped; the inner text shows.
  await expect(body).toContainText("Review this turn's work for any follow-up needed.");
  await expect(body).not.toContainText("<extension-nudge>");
});
