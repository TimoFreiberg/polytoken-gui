import { expect, test } from "@playwright/test";
import { drive, gotoFresh, openSidebar } from "./helpers.js";

// Regression: mid-turn, the context meter + sidebar rows used to freeze at their last
// turn-boundary value. The only events that fire between a turn's start and its
// runCompleted are deltas/tool/user — none carries fresh `usage`, none re-lists
// sessions — so a long-running session showed a stale meter and a stuck row ("(untitled)
// 0 msg"). The hub now re-pushes both on a debounced ticker while a turn runs.
test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("the context meter climbs live while a turn runs", async ({ page }) => {
  const meter = page.getByTestId("context-meter");
  await expect(meter).toHaveText(/24%/); // MOCK_USAGE baseline: 47,200 / 200,000

  await drive(page, "streamhold"); // a turn that goes running and stays running
  // The ticker polls the (growing) mock usage every PILOT_LIVE_REFRESH_MS, so the meter
  // climbs past its frozen baseline without waiting for the turn to end.
  await expect(meter).toHaveText(/2[5-9]%|[3-9]\d%/);
});

test("a running session's sidebar message count climbs live", async ({
  page,
}) => {
  await openSidebar(page);
  const count = page.locator(".row.active .msg-count");
  const num = async (): Promise<number> =>
    Number((await count.textContent())?.match(/\d+/)?.[0] ?? "0");
  await expect(count).toHaveText(/\d+ msg/);
  const before = await num(); // settled count once the greeting turn is idle

  await drive(page, "streamhold");
  // The same ticker re-broadcasts the session list, so the active row's count grows
  // mid-turn instead of staying stuck (the "(untitled) 0 msg" symptom on a new session).
  await expect.poll(num).toBeGreaterThan(before);
});
