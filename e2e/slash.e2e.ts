import { expect, type Page, test } from "@playwright/test";
import { drive, gotoFresh, openRightSidebar } from "./helpers.js";

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
  // Info notice appears in the transcript.
  await expect(page.locator(".row.notice .ntext")).toContainText(
    "Facet switched to plan",
  );
});

test("/facet with no args shows usage error", async ({ page }) => {
  const box = ta(page);
  await box.fill("/facet ");
  // The facet arg menu is open — dismiss it so Enter submits the draft
  // (instead of accepting a facet). This exercises the submit-path guard.
  await box.press("Escape");
  await expect(page.getByTestId("arg-menu")).toHaveCount(0);
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
  // Info notice appears in the transcript.
  await expect(page.locator(".row.notice .ntext")).toContainText(
    "Goal set: ship the feature",
  );
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
  // Info notice appears in the transcript (last notice = most recent action).
  await expect(page.locator(".row.notice .ntext").last()).toContainText(
    "Goal paused",
  );
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
  // Info notice appears in the transcript (last notice = most recent action).
  await expect(page.locator(".row.notice .ntext").last()).toContainText(
    "Goal resumed",
  );
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
  // Info notice appears in the transcript (last notice = most recent action).
  await expect(page.locator(".row.notice .ntext").last()).toContainText(
    "Goal cleared",
  );
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
  // /title does NOT produce a transcript notice (it doesn't affect
  // session contents).
  await expect(page.locator(".row.notice")).toHaveCount(0);
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
  // The goal subcommand menu is open — dismiss it so Enter submits the draft
  // (instead of accepting a subcommand). This exercises the submit-path guard.
  await box.press("Escape");
  await expect(page.getByTestId("arg-menu")).toHaveCount(0);
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
  // /mcp is now client-implemented (no longer omitted).
  await expect(row(page, "mcp")).toBeVisible();
});

// --- /mcp arg-menu (server + action typeahead) ---

const mcpMenu = (page: Page) => page.getByTestId("mcp-arg-menu");
const mcpServerRow = (page: Page, name: string) =>
  mcpMenu(page).locator(`[data-server="${name}"]`);
const mcpActionRow = (page: Page, name: string) =>
  mcpMenu(page).locator(`[data-action="${name}"]`);

test("/mcp appears in the slash menu and is not filtered", async ({ page }) => {
  await ta(page).fill("/m");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  await expect(row(page, "mcp")).toBeVisible();
});

test("typing /mcp<space> opens the server arg menu with both mock servers", async ({
  page,
}) => {
  const box = ta(page);
  await box.fill("/mcp ");
  await expect(mcpMenu(page)).toBeVisible();
  // The mock fixture has 2 servers: filesystem + github.
  await expect(mcpServerRow(page, "filesystem")).toBeVisible();
  await expect(mcpServerRow(page, "github")).toBeVisible();
});

test("the server arg menu filters by substring", async ({ page }) => {
  const box = ta(page);
  await box.fill("/mcp file");
  await expect(mcpMenu(page)).toBeVisible();
  await expect(mcpServerRow(page, "filesystem")).toBeVisible();
  await expect(mcpServerRow(page, "github")).toHaveCount(0);
});

test("selecting a server advances to the action menu listing all four actions", async ({
  page,
}) => {
  const box = ta(page);
  await box.fill("/mcp file");
  await expect(mcpServerRow(page, "filesystem")).toBeVisible();
  await box.press("Enter");
  // Draft now holds the server name + trailing space, action menu opens.
  await expect(box).toHaveValue("/mcp filesystem ");
  await expect(mcpMenu(page)).toBeVisible();
  await expect(mcpActionRow(page, "enable")).toBeVisible();
  await expect(mcpActionRow(page, "disable")).toBeVisible();
  await expect(mcpActionRow(page, "disconnect")).toBeVisible();
  await expect(mcpActionRow(page, "reconnect")).toBeVisible();
});

test("selecting disable dispatches, clears the composer, and flips the sidebar status", async ({
  page,
}) => {
  // Open the right sidebar so the MCP section is visible (it's the test oracle).
  await openRightSidebar(page);
  // filesystem starts connected.
  await expect(
    page.getByTestId("mcp-servers").locator(".mcp-item").first().locator(".mcp-dot"),
  ).toHaveClass(/mcp-connected/);

  const box = ta(page);
  await box.fill("/mcp filesystem ");
  await expect(mcpActionRow(page, "disable")).toBeVisible();
  await box.press("Enter");

  // Composer is cleared (immediate dispatch, no two-Enter).
  await expect(box).toHaveValue("");
  // No user message with "/mcp" is sent.
  await expect(page.locator(".row.user .btext")).toHaveText(
    /^((?!\/mcp).)*$/s,
  );
  // The mock maps disable → Disconnected; the sidebar dot flips.
  await expect(
    page.getByTestId("mcp-servers").locator(".mcp-item").first().locator(".mcp-dot"),
  ).toHaveClass(/mcp-disconnected/);
});

test("submitting /mcp <server> <action> typed (not menu) dispatches", async ({
  page,
}) => {
  await openRightSidebar(page);
  // github starts disconnected — an observable transition.
  const githubRow = page
    .getByTestId("mcp-servers")
    .locator(".mcp-item")
    .filter({ hasText: "github" });
  await expect(githubRow.locator(".mcp-dot")).toHaveClass(/mcp-disconnected/);

  const box = ta(page);
  await box.fill("/mcp github enable");
  await box.press("Enter");

  await expect(box).toHaveValue("");
  await expect(page.locator(".row.user .btext")).toHaveText(
    /^((?!\/mcp).)*$/s,
  );
  // The mock maps enable → Connected; the sidebar dot flips.
  await expect(githubRow.locator(".mcp-dot")).toHaveClass(/mcp-connected/);
});

test("/mcp with no args shows a usage error and does not send", async ({ page }) => {
  const box = ta(page);
  await box.fill("/mcp ");
  // The server arg menu is open — dismiss it so Enter submits the draft
  // (instead of accepting a server). This exercises the submit-path guard.
  await box.press("Escape");
  await expect(page.getByTestId("mcp-arg-menu")).toHaveCount(0);
  await box.press("Enter");

  await expect(page.getByTestId("attachment-status")).toContainText(
    "Usage: /mcp <server> <action>",
  );
  await expect(box).toHaveValue("/mcp ");
  await expect(page.locator(".row.user .btext")).toHaveText(
    /^((?!\/mcp).)*$/s,
  );
});

test("/mcp with an unknown action shows an error and does not send", async ({
  page,
}) => {
  const box = ta(page);
  await box.fill("/mcp filesystem bogus");
  await box.press("Enter");

  await expect(page.getByTestId("attachment-status")).toContainText(
    "Unknown /mcp action: bogus",
  );
  await expect(box).toHaveValue("/mcp filesystem bogus");
  await expect(page.locator(".row.user .btext")).toHaveText(
    /^((?!\/mcp).)*$/s,
  );
});

test("/mcp with an unknown server shows an error and does not send", async ({
  page,
}) => {
  const box = ta(page);
  await box.fill("/mcp nosuchserver enable");
  await box.press("Enter");

  await expect(page.getByTestId("attachment-status")).toContainText(
    "Unknown MCP server: nosuchserver",
  );
  await expect(box).toHaveValue("/mcp nosuchserver enable");
});

// --- /facet arg-menu (facet name typeahead) ---

const argMenu = (page: Page) => page.getByTestId("arg-menu");
const argRow = (page: Page, name: string) =>
  argMenu(page).locator(`[data-name="${name}"]`);

test("typing /facet<space> opens the facet arg menu with all mock facets", async ({
  page,
}) => {
  const box = ta(page);
  await box.fill("/facet ");
  await expect(argMenu(page)).toBeVisible();
  // The mock fixture provides execute, plan, research.
  await expect(argRow(page, "execute")).toBeVisible();
  await expect(argRow(page, "plan")).toBeVisible();
  await expect(argRow(page, "research")).toBeVisible();
});

test("the facet arg menu filters by substring", async ({ page }) => {
  const box = ta(page);
  await box.fill("/facet pl");
  await expect(argMenu(page)).toBeVisible();
  await expect(argRow(page, "plan")).toBeVisible();
  await expect(argRow(page, "execute")).toHaveCount(0);
  await expect(argRow(page, "research")).toHaveCount(0);
});

test("selecting a facet from the menu dispatches and clears the composer", async ({
  page,
}) => {
  const box = ta(page);
  await box.fill("/facet pl");
  await expect(argRow(page, "plan")).toBeVisible();
  await box.press("Enter");

  // Composer is cleared (immediate dispatch, no two-Enter).
  await expect(box).toHaveValue("");
  // Facet badge updates to "Plan".
  await expect(page.getByTestId("facet-badge")).toContainText("Plan");
});

test("arrow keys navigate the facet arg menu and Enter selects the highlighted item", async ({
  page,
}) => {
  const box = ta(page);
  await box.fill("/facet ");
  await expect(argMenu(page)).toBeVisible();
  // Default highlight is on the first item (execute). ArrowDown moves to plan.
  await box.press("ArrowDown");
  await box.press("Enter");

  // Composer is cleared.
  await expect(box).toHaveValue("");
  // Facet badge reads "Plan" (not "Execute" — the first/default item).
  await expect(page.getByTestId("facet-badge")).toContainText("Plan");
});

test("Tab selects the highlighted item in the facet arg menu", async ({
  page,
}) => {
  const box = ta(page);
  await box.fill("/facet ");
  await expect(argMenu(page)).toBeVisible();
  // ArrowDown to the second item (plan), then Tab to accept.
  await box.press("ArrowDown");
  await box.press("Tab");

  await expect(box).toHaveValue("");
  await expect(page.getByTestId("facet-badge")).toContainText("Plan");
});

test("Escape dismisses the facet arg menu without dispatching", async ({
  page,
}) => {
  const box = ta(page);
  await box.fill("/facet ");
  await expect(argMenu(page)).toBeVisible();
  await box.press("Escape");

  // Menu closed, composer still holds the text, no facet change.
  await expect(argMenu(page)).toHaveCount(0);
  await expect(box).toHaveValue("/facet ");
});

// --- /goal arg-menu (subcommand typeahead) ---

test("typing /goal<space> opens the subcommand menu with set/clear/pause/resume", async ({
  page,
}) => {
  const box = ta(page);
  await box.fill("/goal ");
  await expect(argMenu(page)).toBeVisible();
  await expect(argRow(page, "set")).toBeVisible();
  await expect(argRow(page, "clear")).toBeVisible();
  await expect(argRow(page, "pause")).toBeVisible();
  await expect(argRow(page, "resume")).toBeVisible();
});

test("the goal subcommand menu filters by substring", async ({ page }) => {
  const box = ta(page);
  await box.fill("/goal cl");
  await expect(argMenu(page)).toBeVisible();
  await expect(argRow(page, "clear")).toBeVisible();
  await expect(argRow(page, "set")).toHaveCount(0);
  await expect(argRow(page, "pause")).toHaveCount(0);
  await expect(argRow(page, "resume")).toHaveCount(0);
});

test("selecting set from the menu inserts /goal set and shows the hint", async ({
  page,
}) => {
  const box = ta(page);
  await box.fill("/goal se");
  await expect(argRow(page, "set")).toBeVisible();
  await box.press("Enter");

  // Composer holds "/goal set " (no dispatch), hint is visible, menu closed.
  await expect(box).toHaveValue("/goal set ");
  await expect(page.getByTestId("goal-set-hint")).toBeVisible();
  await expect(argMenu(page)).toHaveCount(0);
});

test("selecting clear from the menu dispatches immediately", async ({
  page,
}) => {
  // Set a goal first so clearing has an observable effect.
  await ta(page).fill("/goal set ship the feature");
  await ta(page).press("Enter");
  await expect(page.getByTestId("goal-badge")).toBeVisible();

  const box = ta(page);
  await box.fill("/goal cl");
  await expect(argRow(page, "clear")).toBeVisible();
  await box.press("Enter");

  // Composer is cleared, goal badge is gone.
  await expect(box).toHaveValue("");
  await expect(page.getByTestId("goal-badge")).toHaveCount(0);
});

test("arrow keys navigate the goal subcommand menu and Enter selects the highlighted item", async ({
  page,
}) => {
  // Set a goal first so clearing has an observable effect.
  await ta(page).fill("/goal set ship the feature");
  await ta(page).press("Enter");
  await expect(page.getByTestId("goal-badge")).toBeVisible();

  const box = ta(page);
  await box.fill("/goal ");
  await expect(argMenu(page)).toBeVisible();
  // Default highlight is on the first item (clear, alphabetical). ArrowDown
  // moves to pause.
  await box.press("ArrowDown");
  await box.press("Enter");

  // Composer is cleared, goal badge shows paused state.
  await expect(box).toHaveValue("");
  await expect(page.getByTestId("goal-badge")).toHaveClass(/paused/);
});

test("Tab selects the highlighted item in the goal subcommand menu", async ({
  page,
}) => {
  // Set a goal first so clearing has an observable effect.
  await ta(page).fill("/goal set ship the feature");
  await ta(page).press("Enter");
  await expect(page.getByTestId("goal-badge")).toBeVisible();

  const box = ta(page);
  await box.fill("/goal ");
  await expect(argMenu(page)).toBeVisible();
  // ArrowDown to the second item (pause), then Tab to accept.
  await box.press("ArrowDown");
  await box.press("Tab");

  await expect(box).toHaveValue("");
  await expect(page.getByTestId("goal-badge")).toHaveClass(/paused/);
});

test("Escape dismisses the goal subcommand menu without dispatching", async ({
  page,
}) => {
  const box = ta(page);
  await box.fill("/goal ");
  await expect(argMenu(page)).toBeVisible();
  await box.press("Escape");

  // Menu closed, composer still holds the text, no goal change.
  await expect(argMenu(page)).toHaveCount(0);
  await expect(box).toHaveValue("/goal ");
});
