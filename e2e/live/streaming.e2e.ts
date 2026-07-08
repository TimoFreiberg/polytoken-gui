import { expect, test } from "@playwright/test";
import { driveLive, gotoFreshLive } from "./helpers.js";

// LIVE tier (PANTOKEN_DRIVER=fake). Structural assertions only — the corpus content
// differs from the mock fixtures, so we assert the shape of the rendered turn, not
// its text. NOTE: authored against the corpus + existing mock DOM selectors but not
// executed in a browser in this session; the CI live job is their first real run.

test.beforeEach(async ({ page }) => {
  await gotoFreshLive(page);
});

test("a streamed turn folds corpus SSE into an assistant bubble that settles", async ({
  page,
}) => {
  await driveLive(page, "stream");

  // The streaming-turn corpus folds message_start → content deltas → tool →
  // message_complete. Structurally: an assistant row renders, and the turn settles
  // (the working indicator clears once message_complete lands).
  await expect(page.locator(".row.assistant").first()).toBeVisible();
  await expect(page.getByTestId("working-indicator")).toHaveCount(0, {
    timeout: 10_000,
  });
});
