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

test("the model picker lists models and switches the active one", async ({
  page,
}) => {
  // The badge shows the mock's default model as a friendly label (raw id in tooltip).
  const modelBadge = page
    .locator(".mp .badge")
    .filter({ hasText: "Claude Opus 4.8" });
  await expect(modelBadge).toBeVisible();

  await modelBadge.click();

  // Providers are collapsible and start collapsed except the active one (anthropic), so a
  // non-active provider's models are hidden until you expand its header.
  const panel = page.locator(".mp .panel");
  await expect(panel.getByText("DeepSeek V4 Flash")).toHaveCount(0);
  await panel.locator(".group-title").filter({ hasText: "deepseek" }).click();
  await expect(panel.getByText("DeepSeek V4 Flash")).toBeVisible();
  await panel.getByText("DeepSeek V4 Flash").click();

  // The badge reflects the switched-to model (server round-trip → folded config).
  await expect(
    page.locator(".mp .badge").filter({ hasText: "DeepSeek V4 Flash" }),
  ).toBeVisible();
});

test("provider groups collapse by default and a search auto-expands matches", async ({
  page,
}) => {
  await page
    .locator(".mp .badge")
    .filter({ hasText: "Claude Opus 4.8" })
    .click();
  const panel = page.locator(".mp .panel");

  // The active provider (anthropic) is seeded open; the others start collapsed.
  await expect(panel.getByText("Claude Opus 4.8")).toBeVisible();
  await expect(panel.getByText("GPT-5")).toHaveCount(0);
  await expect(
    panel.locator(".group-title").filter({ hasText: "openai" }),
  ).toHaveAttribute("aria-expanded", "false");

  // Typing a query auto-expands every matching group without a manual click.
  const search = panel.getByPlaceholder("Search models…");
  await search.fill("gpt");
  await expect(panel.getByText("GPT-5")).toBeVisible();

  // Clearing the query re-collapses back to the seeded state.
  await search.fill("");
  await expect(panel.getByText("GPT-5")).toHaveCount(0);
});

test("the thinking picker switches the level", async ({ page }) => {
  await page.locator(".mp .badge").filter({ hasText: "medium" }).click();
  await page.locator(".mp .item").filter({ hasText: "high" }).click();
  await expect(
    page.locator(".mp .badge").filter({ hasText: "high" }),
  ).toBeVisible();
});

test("the model menu has a search that filters the list", async ({ page }) => {
  await page
    .locator(".mp .badge")
    .filter({ hasText: "Claude Opus 4.8" })
    .click();
  const panel = page.locator(".mp .panel");
  await expect(panel).toBeVisible();
  const search = panel.getByPlaceholder("Search models…");

  await search.fill("deep");
  await expect(panel.getByText("DeepSeek V4 Flash")).toBeVisible();
  await expect(panel.getByText("Claude Opus 4.8")).toHaveCount(0);
  await expect(panel.getByText("GPT-5")).toHaveCount(0);

  // no-match state
  await search.fill("zzzz");
  await expect(panel.getByText("No models match")).toBeVisible();
});

test("⌘⇧M focuses the model search; keyboard select returns focus to composer", async ({
  page,
}) => {
  const composer = page.getByPlaceholder("Message pilot…");
  await composer.click();
  await expect(composer).toBeFocused();

  // Hotkey opens the menu AND lands focus in the search, so arrow/enter work at once.
  await page.keyboard.press("Control+Shift+M");
  const panel = page.locator(".mp .panel");
  await expect(panel).toBeVisible();
  const search = panel.locator(".model-search");
  await expect(search).toBeFocused();

  // Filter to a single match — it becomes the keyboard highlight — then Enter picks it.
  await search.fill("deep");
  await expect(panel.locator(".item.hl")).toHaveText(/DeepSeek V4 Flash/);
  await page.keyboard.press("Enter");

  await expect(
    page.locator(".mp .badge").filter({ hasText: "DeepSeek V4 Flash" }),
  ).toBeVisible();
  // Focus is back in the text field, ready to type.
  await expect(composer).toBeFocused();
});

test("⌘⇧E focuses the thinking menu; arrow+enter selects and returns focus", async ({
  page,
}) => {
  const composer = page.getByPlaceholder("Message pilot…");
  await composer.click();

  await page.keyboard.press("Control+Shift+E");
  const panel = page.getByRole("listbox", { name: "Thinking level" });
  await expect(panel).toBeVisible();
  await expect(panel).toBeFocused();
  // The active level (medium) starts highlighted; arrow down moves to "high".
  await expect(panel.locator(".item.hl")).toHaveText(/medium/);
  await page.keyboard.press("ArrowDown");
  await expect(panel.locator(".item.hl")).toHaveText(/high/);
  await page.keyboard.press("Enter");

  await expect(
    page.locator(".mp .badge").filter({ hasText: "high" }),
  ).toBeVisible();
  await expect(composer).toBeFocused();
});

test("Esc closes the picker and returns focus to the composer", async ({
  page,
}) => {
  const composer = page.getByPlaceholder("Message pilot…");
  await composer.click();

  await page.keyboard.press("Control+Shift+M");
  await expect(page.locator(".mp .panel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".mp .panel")).toHaveCount(0);
  await expect(composer).toBeFocused();
});
