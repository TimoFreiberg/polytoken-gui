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
  // Use "/rev" (not "/re") so only "review" matches — builtins like
  // "reset-shell" also prefix-match "/re" and sort before "review".
  await box.fill("/rev");
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

// --- New builtin interception tests ---

test("/facet <name> is intercepted and switches facet", async ({ page }) => {
  const box = ta(page);
  await box.fill("/facet plan");
  await box.press("Enter");

  // Composer is cleared.
  await expect(box).toHaveValue("");
  // No user message with "/facet" is sent.
  await expect(page.locator(".row.user .btext")).toHaveText(
    /^((?!\/facet).)*$/s,
  );
  // Facet badge updates to "Plan".
  await expect(page.getByTestId("facet-badge")).toContainText("Plan");
});

test("/facet with no args shows usage error", async ({ page }) => {
  const box = ta(page);
  await box.fill("/facet ");
  await box.press("Enter");

  await expect(page.getByTestId("attachment-status")).toContainText(
    "Usage: /facet <name>",
  );
  await expect(box).toHaveValue("/facet ");
});

test("/reset-shell is intercepted and shows a notification", async ({
  page,
}) => {
  const box = ta(page);
  await box.fill("/reset-shell");
  await box.press("Enter");

  await expect(box).toHaveValue("");
  await expect(page.locator(".row.user .btext")).toHaveText(
    /^((?!\/reset-shell).)*$/s,
  );
  // Mock emits HostUiRequest::Notify "Shell environment restored".
  await expect(page.locator(".row.notice .ntext")).toContainText(
    "Shell environment restored",
  );
});

test("/daemon-reload is intercepted and shows a notification", async ({
  page,
}) => {
  const box = ta(page);
  await box.fill("/daemon-reload");
  await box.press("Enter");

  await expect(box).toHaveValue("");
  await expect(page.locator(".row.user .btext")).toHaveText(
    /^((?!\/daemon-reload).)*$/s,
  );
  await expect(page.locator(".row.notice .ntext")).toContainText(
    "Daemon config reloaded",
  );
});

test("/goal set <text> is intercepted and shows the goal badge", async ({
  page,
}) => {
  const box = ta(page);
  await box.fill("/goal set ship the feature");
  await box.press("Enter");

  await expect(box).toHaveValue("");
  await expect(page.locator(".row.user .btext")).toHaveText(
    /^((?!\/goal).)*$/s,
  );
  // Goal badge appears with the summary.
  await expect(page.getByTestId("goal-badge")).toBeVisible();
  await expect(page.getByTestId("goal-badge")).toContainText("ship the feature");
});

test("/goal pause is intercepted and shows paused state", async ({ page }) => {
  // Set a goal first.
  await ta(page).fill("/goal set ship the feature");
  await ta(page).press("Enter");
  await expect(page.getByTestId("goal-badge")).toBeVisible();

  const box = ta(page);
  await box.fill("/goal pause");
  await box.press("Enter");

  await expect(box).toHaveValue("");
  // Goal badge shows paused class.
  await expect(page.getByTestId("goal-badge")).toHaveClass(/paused/);
});

test("/goal resume is intercepted and returns to active state", async ({
  page,
}) => {
  // Set + pause first.
  await ta(page).fill("/goal set ship the feature");
  await ta(page).press("Enter");
  await ta(page).fill("/goal pause");
  await ta(page).press("Enter");
  await expect(page.getByTestId("goal-badge")).toHaveClass(/paused/);

  const box = ta(page);
  await box.fill("/goal resume");
  await box.press("Enter");

  await expect(box).toHaveValue("");
  // Goal badge no longer has paused class.
  await expect(page.getByTestId("goal-badge")).not.toHaveClass(/paused/);
});

test("/goal clear is intercepted and removes the goal badge", async ({
  page,
}) => {
  // Set a goal first.
  await ta(page).fill("/goal set ship the feature");
  await ta(page).press("Enter");
  await expect(page.getByTestId("goal-badge")).toBeVisible();

  const box = ta(page);
  await box.fill("/goal clear");
  await box.press("Enter");

  await expect(box).toHaveValue("");
  // Goal badge disappears.
  await expect(page.getByTestId("goal-badge")).toHaveCount(0);
});

test("/title <text> is intercepted and updates the session title", async ({
  page,
}) => {
  const box = ta(page);
  await box.fill("/title my custom title");
  await box.press("Enter");

  await expect(box).toHaveValue("");
  await expect(page.locator(".row.user .btext")).toHaveText(
    /^((?!\/title).)*$/s,
  );
  // Status header title updates.
  await expect(page.locator(".title-row .title")).toContainText(
    "my custom title",
  );
});

test("/title with no args clears the title override", async ({ page }) => {
  // Set a custom title first.
  await ta(page).fill("/title my custom title");
  await ta(page).press("Enter");
  await expect(page.locator(".title-row .title")).toContainText(
    "my custom title",
  );

  // /title with no args clears the override → reverts to the inferred title.
  const box = ta(page);
  await box.fill("/title ");
  await box.press("Enter");

  await expect(box).toHaveValue("");
  // Title reverts to the mock's default (no longer "my custom title").
  await expect(page.locator(".title-row .title")).not.toContainText(
    "my custom title",
  );
});

test("/goal with no args shows usage info", async ({ page }) => {
  const box = ta(page);
  await box.fill("/goal ");
  await box.press("Enter");

  await expect(page.getByTestId("attachment-status")).toContainText(
    "Use /goal set <text>, /goal pause, /goal resume, or /goal clear",
  );
});

// --- Filtered commands ---

test("filtered commands do not appear in the slash menu", async ({ page }) => {
  await ta(page).fill("/jo");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  // /jobs is filtered (interactive, no UI), so it should not appear.
  await expect(row(page, "jobs")).toHaveCount(0);
});

test("a filtered command typed manually shows unknown error", async ({
  page,
}) => {
  const box = ta(page);
  await box.fill("/jobs ");
  await box.press("Enter");

  await expect(page.getByTestId("attachment-status")).toContainText(
    "Unknown slash command: /jobs",
  );
  await expect(box).toHaveValue("/jobs ");
  await expect(page.locator(".row.user .btext")).toHaveText(
    /^((?!\/jobs).)*$/s,
  );
});

test("new builtins appear in the slash menu", async ({ page }) => {
  await ta(page).fill("/");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  // Implemented builtins should be discoverable.
  await expect(row(page, "reset-shell")).toBeVisible();
  await expect(row(page, "daemon-reload")).toBeVisible();
  await expect(row(page, "goal")).toBeVisible();
  await expect(row(page, "title")).toBeVisible();
  await expect(row(page, "facet")).toBeVisible();
});
