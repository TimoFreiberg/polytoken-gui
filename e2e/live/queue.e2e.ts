import { expect, test } from "@playwright/test";
import { driveLive, gotoFreshLive } from "./helpers.js";

// LIVE tier (PANTOKEN_DRIVER=fake). See streaming.e2e.ts for the structural-only +
// unrun-in-session caveats.

test.beforeEach(async ({ page }) => {
  await gotoFreshLive(page);
});

// The queue-while-in-flight corpus is a LIVE capture that runs to completion:
// it queues a prompt (pending_turn_input_queued) mid-flight, streams the first
// turn, then DRAINS the queue (pending_turn_input_drained → QueueUpdated []),
// then runs the queued turn. So the tray is TRANSIENT — populated only during
// the first turn's streaming window. A post-`driveLive` "tray visible" assertion
// would race the drain and flake.
//
// `driveLive` is fire-and-forget: `run_script` spawns the paced SSE push and
// returns immediately, so this poll begins WHILE the push is still streaming
// the first turn — i.e. inside the tray's populated window. We poll a bounded
// window for the tray to appear populated AT SOME POINT mid-flight (the
// controlled push paces frames so that window is observable, not sub-millisecond),
// capturing its label while it's visible rather than asserting on it afterward
// (by which point the drain may have cleared it).
test("a mid-flight queued prompt surfaces in the queue tray", async ({ page }) => {
  await driveLive(page, "queue");

  let sawLabel = false;
  await expect
    .poll(
      async () => {
        const tray = page.getByTestId("queue-tray");
        if ((await tray.count()) > 0 && (await tray.isVisible())) {
          // Capture the label while the tray is actually present, so the
          // assertion doesn't race the drain.
          sawLabel ||= (await tray.textContent())?.includes("Queued") ?? false;
        }
        return sawLabel;
      },
      // The first turn's streaming window (paced frames) is the populated
      // window; a 6s ceiling covers a slow CI runner's fold latency.
      { timeout: 6_000, intervals: [50, 100, 200] },
    )
    .toBe(true);

  expect(sawLabel).toBe(true);
});
