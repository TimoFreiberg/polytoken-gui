import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("the Stop button names the Escape hotkey", async ({ page }) => {
  await drive(page, "pendinghold");
  await expect(page.locator(".composer-wrap .stop")).toHaveAttribute(
    "title",
    "Stop the agent (Esc)",
  );
});

test("Escape aborts a pending turn and restores the sent prompt to the composer", async ({
  page,
}) => {
  // A turn that's been sent but hasn't produced any output yet (thinking only) — the
  // case where the just-sent prompt should come back so it can be edited/resent.
  await drive(page, "pendinghold");
  await expect(page.getByText("Refactor the auth middleware")).toBeVisible();

  const stop = page.locator(".composer-wrap .stop");
  await expect(stop).toBeVisible();

  const ta = page.locator(".composer-wrap textarea");
  await expect(ta).toHaveValue("");
  await ta.focus();
  await page.keyboard.press("Escape");

  // The turn aborts: the Stop pill clears…
  await expect(stop).toHaveCount(0);
  // …and the prompt is back in the composer (history is left alone — the orphaned
  // user message stays in the transcript).
  await expect(ta).toHaveValue("Refactor the auth middleware");
  await expect(page.getByText("Refactor the auth middleware")).toBeVisible();
});

test("Escape while typing a follow-up aborts but does not clobber the draft", async ({
  page,
}) => {
  await drive(page, "pendinghold");
  const stop = page.locator(".composer-wrap .stop");
  await expect(stop).toBeVisible();

  const ta = page.locator(".composer-wrap textarea");
  await ta.fill("a different follow-up");
  await page.keyboard.press("Escape");

  // Still aborts the turn…
  await expect(stop).toHaveCount(0);
  // …but the in-progress text is preserved (restore is skipped when the box isn't empty).
  await expect(ta).toHaveValue("a different follow-up");
});
