import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

// An extension nudge (the daemon's sendMessage, e.g. journal-nudge) triggers a fresh run with
// no user prompt. It remains in the same outer turn, but the injected pill and the prior
// assistant response stay chronological and visible while the later tool run remains work.
test("a journal nudge keeps the prior turn's response visible and shows a collapsed pill", async ({
  page,
}) => {
  await drive(page, "journalnudge");

  // Turn 1's real final response is visible WITHOUT expanding any work block. If the
  // bug regressed it would live inside the collapsed work block and not render at all.
  await expect(page.getByText("renamed", { exact: false })).toBeVisible();

  // The injected nudge renders as a tiny collapsed pill labelled by its customType…
  const pill = page.locator(".inject-pill");
  await expect(pill).toBeVisible();
  await expect(pill).toContainText("journal-nudge");

  // …whose body is hidden until expanded, and never shows the raw XML wrapper.
  await expect(page.locator(".inject-body")).toHaveCount(0);

  // The nudge run's own response (after the journal call) is also visible.
  await expect(
    page.getByText("Journaled a note", { exact: false }),
  ).toBeVisible();
});

test("expanding the nudge pill reveals the de-wrapped note text", async ({
  page,
}) => {
  await drive(page, "journalnudge");

  const pill = page.locator(".inject-pill");
  await expect(pill).toBeVisible();
  await expect(pill).toHaveAttribute("aria-expanded", "false");
  await pill.click();
  await expect(pill).toHaveAttribute("aria-expanded", "true");

  const body = page.locator(".inject-body");
  await expect(body).toBeVisible();
  // The outer <journal-nudge> wrapper is stripped; the inner text shows.
  await expect(body).toContainText("this turn did work and didn't journal");
  await expect(body).not.toContainText("<journal-nudge>");
});
