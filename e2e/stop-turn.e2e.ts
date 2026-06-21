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
  await expect(page.locator(".composer-wrap .stop")).toBeVisible();
});

test("the Stop pill disables while offline (a remote turn can't be stopped)", async ({
  page,
}) => {
  await drive(page, "streamhold"); // goes running and stays running
  const stop = page.locator(".composer-wrap .stop");
  await expect(stop).toBeEnabled();

  // Drop the socket: the turn keeps running server-side, so the pill stays visible but
  // goes inert (a dead click would silently no-op) with an explanatory tooltip.
  await page.evaluate(() =>
    window.dispatchEvent(new Event("pilot:test-disconnect")),
  );
  await expect(stop).toBeDisabled();
  await expect(stop).toHaveAttribute(
    "title",
    "Can't stop while offline — the agent keeps running",
  );
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
  const summary = page.locator(".tool.summary");
  // While the turn is still live, the tool run is unsealed — the header shows the
  // tool name rather than the programmatic prose summary.
  await expect(summary.locator(":scope > .head .label")).toHaveText("bash");
  await expect(summary).toHaveClass(/running/);
  // A running run keeps a status dot (the one signal a subdued row still shows).
  await expect(summary.locator(":scope > .head .status")).toHaveText("○");

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
  const stop = page.locator(".composer-wrap .stop");
  await expect(stop).toBeVisible();
  await expect(page.getByTestId("working-indicator")).toBeVisible();

  // And Stop actually ends the turn: the affordance clears.
  await stop.click();
  await expect(stop).toHaveCount(0);
  await expect(page.getByTestId("working-indicator")).toHaveCount(0);
});
