import { expect, type Page, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

const ta = (page: Page) => page.locator(".composer-wrap textarea");
const row = (page: Page, name: string) =>
  page.getByTestId("slash-menu").locator(`[data-cmd="${name}"]`);

test("a leading slash opens the command menu", async ({ page }) => {
  await ta(page).fill("/");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  // All three command sources (from MOCK_COMMANDS) are offered.
  await expect(row(page, "review")).toBeVisible();
  await expect(row(page, "plan")).toBeVisible();
  await expect(row(page, "skill:debug")).toBeVisible();
});

test("typing filters the menu to matching commands", async ({ page }) => {
  await ta(page).fill("/re");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  await expect(row(page, "review")).toBeVisible();
  // "plan" doesn't contain "re", so it's filtered out.
  await expect(row(page, "plan")).toHaveCount(0);
});

test("Enter accepts the highlighted command into the draft", async ({
  page,
}) => {
  const box = ta(page);
  await box.fill("/re");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  await box.press("Enter");
  // The bare token is replaced with `/name ` (trailing space) and the menu closes —
  // no message is sent, so the user can add arguments.
  await expect(box).toHaveValue("/review ");
  await expect(page.getByTestId("slash-menu")).toHaveCount(0);
});

test("clicking a command inserts it", async ({ page }) => {
  const box = ta(page);
  await box.fill("/sk");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  await row(page, "skill:journal").click();
  await expect(box).toHaveValue("/skill:journal ");
});

test("Escape dismisses the menu without changing the draft", async ({
  page,
}) => {
  const box = ta(page);
  await box.fill("/re");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  await box.press("Escape");
  await expect(page.getByTestId("slash-menu")).toHaveCount(0);
  await expect(box).toHaveValue("/re");
});

// --- Slash-command interception (submit path) ---

test("/clear is intercepted and clears context instead of sending text", async ({
  page,
}) => {
  // Drive to contextfull so the drop to 0% is unambiguous (mirrors
  // context-meter.e2e.ts).
  await drive(page, "contextfull");
  await expect(page.getByTestId("context-trigger")).toHaveAttribute(
    "aria-label",
    /91% used/,
  );

  const box = ta(page);
  await box.fill("/clear");
  await box.press("Enter");

  // Composer is cleared.
  await expect(box).toHaveValue("");
  // No user message with "/clear" is sent.
  await expect(page.locator(".row.user .btext")).toHaveText(
    /^((?!\/clear).)*$/s,
  );
  // Context meter drops to 0% (mock emits UsageUpdated for ClearContext).
  await expect(page.getByTestId("context-trigger")).toHaveAttribute(
    "aria-label",
    /0% used/,
  );
});

test("/compact is intercepted and triggers compaction instead of sending text", async ({
  page,
}) => {
  await drive(page, "contextfull");
  await expect(page.getByTestId("context-trigger")).toHaveAttribute(
    "aria-label",
    /91% used/,
  );

  const box = ta(page);
  await box.fill("/compact");
  await box.press("Enter");

  await expect(box).toHaveValue("");
  await expect(page.locator(".row.user .btext")).toHaveText(
    /^((?!\/compact).)*$/s,
  );
  // Mock emits UsageUpdated { percent: 4 } for Compact.
  await expect(page.getByTestId("context-trigger")).toHaveAttribute(
    "aria-label",
    /4% used/,
  );
});

test("/compact with args is intercepted (args accepted but ignored)", async ({
  page,
}) => {
  await drive(page, "contextfull");

  const box = ta(page);
  await box.fill("/compact summarize this");
  await box.press("Enter");

  await expect(box).toHaveValue("");
  await expect(page.getByTestId("context-trigger")).toHaveAttribute(
    "aria-label",
    /4% used/,
  );
});

test("an unknown slash command shows an inline error and is not sent", async ({
  page,
}) => {
  const box = ta(page);
  await box.fill("/nonexistent");
  await box.press("Enter");

  // Inline error appears.
  await expect(page.getByTestId("attachment-status")).toContainText(
    "Unknown slash command: /nonexistent",
  );
  // Composer is NOT cleared — the text stays.
  await expect(box).toHaveValue("/nonexistent");
  // No user message is sent.
  await expect(page.locator(".row.user .btext")).toHaveText(
    /^((?!\/nonexistent).)*$/s,
  );
});

test("a known command passes through as text", async ({ page }) => {
  const box = ta(page);
  // Type with a trailing space so the slash typeahead menu doesn't open
  // (slashQuery returns null once whitespace appears). This tests the
  // submit() passthrough path directly — the menu-accept path is covered
  // by the existing "Enter accepts the highlighted command" test.
  await box.fill("/review ");
  await box.press("Enter");

  // The mock sends it as a normal prompt — the latest user message is "/review".
  await expect(page.locator(".row.user .btext").last()).toContainText("/review");
});
