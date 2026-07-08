import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

// Regression: mid-turn, the context meter used to freeze at its last turn-boundary
// value. The only events that fire between a turn's start and its runCompleted are
// deltas/tool/user — none carries fresh `usage` — so a long-running session showed a
// stale meter. The hub now re-pushes usage on a debounced ticker while a turn runs.
// (The companion guard — that the ticker also re-broadcasts the session LIST mid-turn —
// lives in hub.test.ts "the live ticker refreshes the session list + focused usage
// mid-turn"; the sidebar no longer renders a per-row message count to assert on here.)
test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("the context meter climbs live while a turn runs", async ({ page }) => {
  const meter = page.getByTestId("context-meter");
  await expect(meter).toHaveText(/24%/); // MOCK_USAGE baseline: 47,200 / 200,000

  await drive(page, "streamhold"); // a turn that goes running and stays running
  // The ticker polls the (growing) mock usage every PANTOKEN_LIVE_REFRESH_MS, so the meter
  // climbs past its frozen baseline without waiting for the turn to end.
  await expect(meter).toHaveText(/2[5-9]%|[3-9]\d%/);
});
