import { expect, test } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
  // gotoFresh waits for the greeting's last text, but the greeting fires one more
  // runCompleted ~60ms later carrying the DEFAULT model config. These tests assert
  // config survives a switch, so let that trailing snapshot land first or it can
  // clobber the selection mid-test (the mock's only competing config source).
  await page.waitForTimeout(300);
});

test("the combined badge shows model and effort", async ({ page }) => {
  // AC.2 — one combined badge shows both model label and effort.
  const badge = page.getByTestId("model-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toContainText("Claude Opus 4.8");
  await expect(badge).toContainText("medium");
  // The separate thinking badge no longer exists.
  await expect(page.getByTestId("thinking-badge")).toHaveCount(0);
});

test("the picker lists models and switches the active one", async ({
  page,
}) => {
  const badge = page.getByTestId("model-badge");
  await badge.click();

  const panel = page.locator(".mp .panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByText("DeepSeek V4 Flash")).toBeVisible();
  await panel.getByText("DeepSeek V4 Flash").click();

  // The badge reflects the switched-to model (server round-trip → folded config).
  await expect(
    page.getByTestId("model-badge"),
  ).toContainText("DeepSeek V4 Flash");
});

test("the filter fuzzy-matches models", async ({ page }) => {
  // AC.4 — typing in the filter fuzzy-matches models.
  await page.getByTestId("model-badge").click();
  const panel = page.locator(".mp .panel");
  await expect(panel).toBeVisible();
  const filter = panel.getByPlaceholder("Type to filter…");

  await filter.fill("deep");
  await expect(panel.getByText("DeepSeek V4 Flash")).toBeVisible();
  await expect(panel.getByText("Claude Opus 4.8")).toHaveCount(0);
  await expect(panel.getByText("GPT-5")).toHaveCount(0);

  // no-match state
  await filter.fill("zzzz");
  await expect(panel.getByText("No models match")).toBeVisible();
});

test("⌘⇧M opens the picker and focuses the filter; ⌘⇧E does nothing", async ({
  page,
}) => {
  // AC.3
  const composer = page.getByPlaceholder("Message pantoken…");
  await composer.click();
  await expect(composer).toBeFocused();

  await page.keyboard.press("Control+Shift+M");
  const panel = page.locator(".mp .panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByPlaceholder("Type to filter…")).toBeFocused();

  // ⌘⇧E no longer opens anything.
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);

  await page.keyboard.press("Control+Shift+E");
  await expect(page.locator(".mp .panel")).toHaveCount(0);
});

test("selecting a model stages its default effort", async ({ page }) => {
  // AC.5 — selecting a new model resets the staged effort to that model's default.
  await page.getByTestId("model-badge").click();
  const panel = page.locator(".mp .panel");

  // Arrow down to Claude Sonnet 4.6 (second model in the list).
  await panel.getByPlaceholder("Type to filter…").press("ArrowDown");
  // The effort control should show "medium" (Sonnet's defaultThinkingLevel).
  const sonnetRow = panel.locator(".item").filter({ hasText: "Claude Sonnet 4.6" });
  await expect(sonnetRow.locator(".eff-val")).toContainText("medium");
});

test("←/→ and [/] cycle effort with clamping (no wrap)", async ({ page }) => {
  // AC.6
  await page.getByTestId("model-badge").click();
  const panel = page.locator(".mp .panel");
  const filter = panel.getByPlaceholder("Type to filter…");

  // The active model (Opus) starts with effort "medium" (index 2 of [off, low, medium, high]).
  const opusRow = panel.locator(".item").filter({ hasText: "Claude Opus 4.8" });
  await expect(opusRow.locator(".eff-val")).toContainText("medium");

  // Arrow right → "high" (index 3, the last).
  await filter.press("ArrowRight");
  await expect(opusRow.locator(".eff-val")).toContainText("high");

  // Arrow right again — clamped at "high" (no wrap to "off").
  await filter.press("ArrowRight");
  await expect(opusRow.locator(".eff-val")).toContainText("high");

  // [ goes back to "medium".
  await filter.press("[");
  await expect(opusRow.locator(".eff-val")).toContainText("medium");

  // Arrow left → "low".
  await filter.press("ArrowLeft");
  await expect(opusRow.locator(".eff-val")).toContainText("low");

  // Arrow left to "off" then left again — clamped (no wrap to "high").
  await filter.press("ArrowLeft");
  await expect(opusRow.locator(".eff-val")).toContainText("off");
  await filter.press("ArrowLeft");
  await expect(opusRow.locator(".eff-val")).toContainText("off");
});

test("Enter applies the combined model + effort", async ({ page }) => {
  // AC.7 — Enter sends one combined setModel action with both modelId and thinkingLevel.
  await page.getByTestId("model-badge").click();
  const panel = page.locator(".mp .panel");
  const filter = panel.getByPlaceholder("Type to filter…");

  // Arrow down to Sonnet, then arrow right to cycle effort to "high".
  await filter.press("ArrowDown");
  await filter.press("ArrowRight");
  await filter.press("ArrowRight");

  // Enter applies.
  await filter.press("Enter");

  // The badge reflects the new model + effort.
  await expect(page.getByTestId("model-badge")).toContainText("Claude Sonnet 4.6");
  await expect(page.getByTestId("model-badge")).toContainText("high");
});

test("first Esc clears the filter; second Esc closes and refocuses", async ({
  page,
}) => {
  // AC.9
  const composer = page.getByPlaceholder("Message pantoken…");
  await composer.click();

  await page.keyboard.press("Control+Shift+M");
  const panel = page.locator(".mp .panel");
  const filter = panel.getByPlaceholder("Type to filter…");

  await filter.fill("deep");
  await expect(filter).toHaveValue("deep");

  // First Esc clears the query — panel stays open.
  await page.keyboard.press("Escape");
  await expect(filter).toHaveValue("");
  await expect(panel).toBeVisible();

  // Second Esc closes the panel and returns focus to the composer.
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(composer).toBeFocused();
});

test("no-effort models show a select button instead of the effort control", async ({
  page,
}) => {
  // AC.10 — DeepSeek V4 Flash has a single "off" level, so it shows "select".
  await page.getByTestId("model-badge").click();
  const panel = page.locator(".mp .panel");

  // DeepSeek Flash row should have a "select" button (single level → no cycle control).
  const flashRow = panel.locator(".item").filter({ hasText: "DeepSeek V4 Flash" });
  await expect(flashRow.locator(".select-btn")).toBeVisible();

  // Clicking it applies the model directly.
  await flashRow.locator(".select-btn").click();
  await expect(page.getByTestId("model-badge")).toContainText("DeepSeek V4 Flash");
});
