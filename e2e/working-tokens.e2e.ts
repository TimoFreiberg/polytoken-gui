import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

/** Parse the integer out of the "~1,234 tok" liveness readout. */
async function tokenCount(
  page: import("@playwright/test").Page,
): Promise<number> {
  const text = (await page.getByTestId("working-tokens").textContent()) ?? "";
  return Number(text.replace(/[^\d]/g, ""));
}

test("the working spinner shows a token counter that climbs as text streams", async ({
  page,
}) => {
  await drive(page, "streamhold"); // goes running and streams answer TEXT, stays open
  await expect(page.getByTestId("working-indicator")).toBeVisible();
  const counter = page.getByTestId("working-tokens");
  await expect(counter).toBeVisible();
  // The estimate climbs past zero once the API has streamed some tokens.
  await expect.poll(() => tokenCount(page)).toBeGreaterThan(0);
  // A human-readable elapsed timer sits beside it (e.g. "3s", "1m 4s").
  await expect(page.getByTestId("working-elapsed")).toHaveText(
    /^\d+s$|^\d+m( \d+s)?$|^\d+h( \d+m)?$/,
  );
});

test("the token counter also climbs while the model is only thinking", async ({
  page,
}) => {
  await drive(page, "pendinghold"); // streams THINKING deltas, no answer text yet
  // The spinner reads "Thinking…" (hidden thinking is the only other feedback)…
  await expect(page.getByTestId("working-indicator")).toContainText(
    "Thinking…",
  );
  // …yet the counter still proves the API is feeding us tokens.
  await expect(page.getByTestId("working-tokens")).toBeVisible();
  await expect.poll(() => tokenCount(page)).toBeGreaterThan(0);
});
