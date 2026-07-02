import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

// Protocol v2 resume: a reconnect mid-stream must not duplicate transcript
// content. The reconnect hello carries the fold watermark; the server replays
// only the frames missed while disconnected (or re-seeds if it can't), so the
// user message and the streamed reply each appear exactly once either way.
test("a mid-stream reconnect shows no duplicated bubbles", async ({ page }) => {
  await drive(page, "reply");
  // The turn is visibly under way…
  await expect(
    page.getByText("Show me the streamed reply script."),
  ).toBeVisible();
  await expect(page.getByText("Good question.")).toBeVisible();

  // …cut the transport mid-stream. The mock keeps emitting server-side.
  await page.evaluate(() =>
    window.dispatchEvent(new Event("pilot:test-disconnect")),
  );
  await expect(
    page.getByText("Offline — the agent keeps running"),
  ).toBeVisible();

  // Reconnect. The hello carries {epoch, seq}; the server fills the gap.
  await page.getByRole("button", { name: "Reconnect" }).click();
  await expect(page.getByText("Offline — the agent keeps running")).toHaveCount(
    0,
  );

  // The completed reply is present exactly once — nothing doubled by the
  // reconnect, no half-applied transcript. (The mid-turn "Good question…" text
  // collapses into the settled work block, so assert on what stays rendered:
  // the prompt row and the turn-final reply.)
  await expect(
    page.getByText("That confirms it. Making the change now"),
  ).toHaveCount(1);
  await expect(
    page.getByText("Show me the streamed reply script."),
  ).toHaveCount(1);
});
