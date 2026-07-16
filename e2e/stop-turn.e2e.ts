import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("the Stop pill + working indicator show while a normal turn streams", async ({
  page,
}) => {
  await drive(page, "streamhold"); // goes running and stays running
  await expect(page.getByTestId("working-indicator")).toBeVisible();
  // AC.1: no spinner (orbiting dot/coin) renders — the stop button replaced it.
  await expect(
    page.getByTestId("working-indicator").locator(".coin, .dot, .ring, .mark"),
  ).toHaveCount(0);
  await expect(page.getByTestId("stop-button")).toBeVisible();
  // Enter while streaming queues a follow-up (the driver routes mid-turn sends to
  // /turn/input). Enter clears the box (the message is queued) — guards the
  // composer-side behavior the removed toggle tests covered.
  const box = page.getByPlaceholder("Queue a message…");
  await box.fill("a queued nudge");
  await box.press("Enter");
  await expect(box).toHaveValue("");
});

test("the Stop pill disables while offline (a remote turn can't be stopped)", async ({
  page,
}) => {
  await drive(page, "streamhold"); // goes running and stays running
  const stop = page.getByTestId("stop-button");
  await expect(stop).toBeEnabled();

  // Drop the socket: the turn keeps running server-side, so the pill stays visible but
  // goes inert (a dead click would silently no-op) with an explanatory tooltip.
  await page.evaluate(() =>
    window.dispatchEvent(new Event("pantoken:test-disconnect")),
  );
  await expect(stop).toBeDisabled();
  await expect(stop).toHaveAttribute(
    "title",
    "Can't stop while offline — the agent keeps running",
  );
});

test("a slow stop becomes an explicit retry state, then reports late settlement", async ({
  page,
}) => {
  // The mock delays this one abort beyond the client's 500ms confirmation window.
  await drive(page, "slowabort");
  await drive(page, "streamhold");
  const stop = page.getByTestId("stop-button");
  await stop.click();

  await expect(stop).toHaveText("■ Stopping…");
  await expect(stop).toBeDisabled();

  await expect(stop).toHaveText("↻ Retry stop", { timeout: 1_500 });
  await expect(stop).toBeEnabled();
  await expect(
    page.getByTestId("chat-notice").getByTestId("toast").filter({
      hasText: "Couldn't confirm the stop within 500ms",
    }),
  ).toBeVisible();

  // The delayed server outcome still settles the transcript and explains that it
  // arrived after the deadline instead of silently removing the recovery state.
  await expect(stop).toHaveCount(0);
  await expect(page.getByTestId("working-indicator")).toHaveCount(0);
  await expect(
    page
      .getByTestId("sidebar")
      .getByText("Couldn't confirm the stop within 500ms", {
        exact: false,
      }),
  ).toHaveCount(0);
  await expect(
    page.getByTestId("chat-notice").getByTestId("toast").filter({
      hasText: "The agent stopped after Pantoken's 500ms confirmation window.",
    }),
  ).toBeVisible();
});

test("the Stop pill survives a stray mid-turn idle snapshot (turn still in flight)", async ({
  page,
}) => {
  // The regression: a turn goes running, starts a tool, then an out-of-band
  // sessionUpdated(idle) lands while the tool is still executing — the folded
  // status reads idle and the server's running set clears, yet the run is plainly
  // still live. The robust turnActive signal must keep the stop affordance up.
  await drive(page, "staleidle");
  await expect(
    page.getByText("kicking off a command", { exact: false }),
  ).toBeVisible();
  // While the turn is still live, the tool renders as a bare card OUTSIDE any
  // collapsible folder — the user watches the call run before the turn settles.
  await expect(page.locator(".tool.summary")).toHaveCount(0);
  const tool = page
    .locator(".scroller > .tool, .work-body > .tool, .tool.running")
    .first();
  await expect(tool.locator(":scope > .head .name")).toHaveText(
    "Run shell command",
  );
  await expect(tool).toHaveClass(/running/);
  // A running card keeps a blinking status dot.
  await expect(tool.locator(":scope > .head .status")).toHaveText("○");

  // Wait for the stray idle snapshot to land server-side: the folded status flips to
  // "idle" (and stays — the turn never completes), proving the affordance no longer
  // depends on the folded status alone.
  await expect
    .poll(() =>
      page.request
        .get("/debug/state")
        .then((r) => r.json().then((s) => s.status)),
    )
    .toBe("idle");

  // …yet the stop pill + working indicator stay visible because a tool is still running.
  const stop = page.getByTestId("stop-button");
  await expect(stop).toBeVisible();
  await expect(page.getByTestId("working-indicator")).toBeVisible();

  // And Stop actually ends the turn: the affordance clears.
  await stop.click();
  await expect(stop).toHaveCount(0);
  await expect(page.getByTestId("working-indicator")).toHaveCount(0);
});
