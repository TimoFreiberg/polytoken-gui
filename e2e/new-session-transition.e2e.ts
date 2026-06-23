import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

// Sending the first prompt of a deferred new session used to flash the PREVIOUSLY focused
// session's transcript for a beat — the draft hero cleared instantly, but `store.session`
// still held the old session until pi finished warming up and its snapshot landed. The fix
// resets the session to an empty slate on submit and overlays the just-sent prompt, so the
// view goes straight from "draft hero + composer" to "the new prompt at the top + the
// in-session composer", with the working indicator carrying the warm-up gap.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("a new session's first prompt never flashes the previously focused transcript", async ({
  page,
}) => {
  // The greeting (demo) session is focused on load — its prompt is in the transcript.
  const oldPrompt = page.getByText("Add a /health route to the server");
  await expect(oldPrompt).toBeVisible();

  // Start a fresh new-session draft (deferred creation: nothing exists until we send).
  await openSidebar(page);
  await page.getByTestId("sidebar").getByText("New session…").click();
  await expect(page.getByTestId("new-session")).toBeVisible();

  const composer = page.getByPlaceholder("Describe a task or ask a question…");
  await composer.fill("kick off the brand new session please");
  await composer.press("Enter");

  // The just-sent prompt is the FIRST (and only) transcript bubble — the old session's
  // content is gone, never showing the new prompt appended below a stale transcript.
  const firstBubble = page.locator(".row.user .bubble").first();
  await expect(firstBubble).toHaveText("kick off the brand new session please");
  await expect(oldPrompt).toHaveCount(0);

  // We're in the in-session view (the draft hero is gone) and the warm-up / turn indicator
  // is up — "Starting session…" while pi warms, then "Working…" once the run streams.
  await expect(page.getByTestId("new-session")).toHaveCount(0);
  await expect(page.getByTestId("working-indicator")).toBeVisible();

  // The new session's OWN reply streams into ITS transcript (not the demo session's), and
  // the optimistic prompt row has handed off to the authoritative one without duplicating.
  await expect(page.getByText("On it — the session's up")).toBeVisible();
  await expect(
    page.locator(".row.user .bubble", {
      hasText: "kick off the brand new session please",
    }),
  ).toHaveCount(1);
  await expect(oldPrompt).toHaveCount(0);
});
