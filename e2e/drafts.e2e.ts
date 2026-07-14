import { expect, type Page, test } from "@playwright/test";
import { drive, gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

const composer = (page: Page) => page.locator(".composer-wrap textarea");
function row(page: Page, title: string) {
  return page.getByTestId("sidebar").locator(".row", { hasText: title });
}

test("a per-session draft survives switching away and back", async ({
  page,
}) => {
  await openSidebar(page);
  await composer(page).fill("notes for the bridge session");

  // Switch to another session — its (empty) draft replaces the text.
  await row(page, "Explore the fold reducer").click();
  await openSidebar(page);
  await expect(composer(page)).toHaveValue("");

  // Back to the first session — the draft is restored.
  await row(page, "Wire up the WebSocket bridge").click();
  await openSidebar(page);
  await expect(composer(page)).toHaveValue("notes for the bridge session");
});

test("a per-session draft survives a reload", async ({ page }) => {
  await composer(page).fill("survive a reload");
  // pagehide on reload flushes the draft to localStorage; boot restores the focused
  // session's draft.
  await page.reload();
  await expect(composer(page)).toHaveValue("survive a reload");
});

test("a pending new-session draft is restored when you reopen the new view", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();
  const draftBox = page.getByPlaceholder("Describe a task or ask a question…");
  await draftBox.fill("a brand-new idea");

  // Navigate to an existing session — exits the draft (composer reflects that session).
  await row(page, "Explore the fold reducer").click();
  await openSidebar(page);
  await expect(composer(page)).toHaveValue("");

  // Reopen the new-session view (same project) — the idea is still there.
  await page.getByRole("button", { name: "New session…" }).click();
  await expect(
    page.getByPlaceholder("Describe a task or ask a question…"),
  ).toHaveValue("a brand-new idea");
});

test("a pending new-session draft's worktree toggle survives leaving and reopening", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();
  const worktree = page.getByRole("button", { name: "worktree" });
  await expect(worktree).toHaveAttribute("aria-pressed", "false");
  await worktree.click();
  await expect(worktree).toHaveAttribute("aria-pressed", "true");

  // Navigate to an existing session — exits the draft.
  await row(page, "Explore the fold reducer").click();
  await openSidebar(page);
  await expect(composer(page)).toHaveValue("");

  // Reopen the new-session view (same project) — the toggle is still on.
  await page.getByRole("button", { name: "New session…" }).click();
  await expect(page.getByRole("button", { name: "worktree" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("a pending new-session draft's worktree toggle survives a reload", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();
  await page.getByRole("button", { name: "worktree" }).click();
  await page.reload();
  // Boot restores the focused session, not the draft, so reopen the new view.
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();
  await expect(page.getByRole("button", { name: "worktree" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

// Pick a non-default model (Sonnet — same anthropic group as the Opus default, which is
// seeded open) and a non-default thinking level (high), then assert the badges reflect it.
async function pickNonDefaultModelAndThinking(page: Page): Promise<void> {
  await page
    .locator(".mp .badge")
    .filter({ hasText: "Claude Opus 4.8" })
    .click();
  await page.locator(".mp .panel").getByText("Claude Sonnet 4.6").click();
  await expect(
    page.locator(".mp .badge").filter({ hasText: "Claude Sonnet 4.6" }),
  ).toBeVisible();

  await page.locator(".mp .badge").filter({ hasText: "medium" }).click();
  await page.locator(".mp .item").filter({ hasText: "high" }).click();
  await expect(
    page.locator(".mp .badge").filter({ hasText: "high" }),
  ).toBeVisible();
}

async function expectNonDefaultModelAndThinking(page: Page): Promise<void> {
  await expect(
    page.locator(".mp .badge").filter({ hasText: "Claude Sonnet 4.6" }),
  ).toBeVisible();
  await expect(
    page.locator(".mp .badge").filter({ hasText: "high" }),
  ).toBeVisible();
}

test("a pending new-session draft's model + thinking survive leaving and reopening", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();
  await pickNonDefaultModelAndThinking(page);

  // Navigate to an existing session — exits the draft.
  await row(page, "Explore the fold reducer").click();
  await openSidebar(page);
  await expect(composer(page)).toHaveValue("");

  // Reopen the new-session view (same project) — the picks are still there.
  await page.getByRole("button", { name: "New session…" }).click();
  await expectNonDefaultModelAndThinking(page);
});

test("a pending new-session draft's model + thinking survive a reload", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();
  await pickNonDefaultModelAndThinking(page);

  await page.reload();
  // Boot restores the focused session, not the draft, so reopen the new view.
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();
  await expectNonDefaultModelAndThinking(page);
});

test("sending a prompt clears its stored draft (no resurrection on return)", async ({
  page,
}) => {
  await openSidebar(page);
  const box = composer(page);
  await box.fill("ephemeral");
  await box.press("Enter");
  await expect(box).toHaveValue("");

  // Leave and come back — the sent draft must NOT reappear.
  await row(page, "Explore the fold reducer").click();
  await openSidebar(page);
  await row(page, "Wire up the WebSocket bridge").click();
  await openSidebar(page);
  await expect(composer(page)).toHaveValue("");
});

test("a new-session draft hides the focused session's tasklist pill", async ({
  page,
}) => {
  await drive(page, "ambient");
  const pill = page.getByRole("button", { name: /3 tasks/ });
  await expect(pill).toBeVisible();

  // Opening the new-session view is a client overlay over the focused session;
  // that session's tasklist must not bleed into the fresh draft (which has none).
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();
  await expect(
    page.getByPlaceholder("Describe a task or ask a question…"),
  ).toBeVisible();
  await expect(pill).toBeHidden();
});

test("a new-session draft hides the previous session's goal badge and ambient statuses", async ({
  page,
}) => {
  // Set a goal + ambient statuses on the focused session.
  await drive(page, "goalactive");
  await drive(page, "ambient");

  // Verify the goal badge and at least one ambient status are visible.
  const badge = page.getByTestId("goal-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toContainText("Ship the goal badge feature");
  const ambient = page.locator(".hdr .amb");
  await expect(ambient).toHaveCount(1);
  await expect(ambient).toContainText("on main · 2 files changed");

  // The document title should reflect the focused session.
  await expect(page).toHaveTitle("Wire up the WebSocket bridge · pantoken");

  // Open a new-session draft — the previous session's goal badge, ambient
  // statuses, and title must not bleed into the fresh draft view.
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();
  await expect(
    page.getByPlaceholder("Describe a task or ask a question…"),
  ).toBeVisible();
  await expect(badge).toHaveCount(0);
  await expect(page.locator(".hdr .amb")).toHaveCount(0);
  await expect(page).toHaveTitle("New session · pantoken");

  // Navigate back to the session — goal badge, ambient statuses, and title
  // are restored.
  await openSidebar(page);
  await row(page, "Wire up the WebSocket bridge").click();
  await expect(badge).toBeVisible();
  await expect(page.locator(".hdr .amb")).toHaveCount(1);
  await expect(page).toHaveTitle("Wire up the WebSocket bridge · pantoken");
});

test("a new-session draft hides the previous session's dialogs and context panel", async ({
  page,
}) => {
  // Raise a blocking confirm on the focused session.
  await drive(page, "confirm");
  await expect(page.getByRole("dialog")).toBeVisible();

  // The draft view must not show the OTHER session's approval popup, nor its
  // context panel (flags/jobs/todos) or the panel's pop-in tab.
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();
  await expect(
    page.getByPlaceholder("Describe a task or ask a question…"),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByTestId("right-sidebar")).toBeHidden();
  await expect(page.getByTestId("context-open")).toBeHidden();
  // The document title is neutral while drafting — not the previous session's.
  await expect(page).toHaveTitle("New session · pantoken");

  // Returning to the session re-surfaces the still-pending dialog.
  await openSidebar(page);
  await row(page, "Wire up the WebSocket bridge").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page).toHaveTitle("Wire up the WebSocket bridge · pantoken");
});

test("⌘⇧C in a new-session draft changes the DRAFT's facet, not the session's", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toContainText("Execute");

  // ⌘⇧C opens the facet menu; pick Plan — only the draft's pick moves.
  await page.keyboard.press("Meta+Shift+C");
  await page.getByRole("option", { name: "Plan" }).click();
  await expect(badge).toContainText("Plan");

  // Exit the draft to a live session — its facet must be untouched.
  await row(page, "Explore the fold reducer").click();
  await expect(badge).toContainText("Execute");

  // Reopen the draft — the plan pick survived (rides draftConfigMap).
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();
  await expect(badge).toContainText("Plan");
});

test("submitting a draft carries its facet into the created session", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toContainText("Execute");
  await page.keyboard.press("Meta+Shift+C");
  await page.getByRole("option", { name: "Plan" }).click();
  await expect(badge).toContainText("Plan");

  const box = composer(page);
  await box.fill("start in plan mode");
  await box.press("Enter");
  // The created session's seed snapshot carries the facet pick, so the badge
  // still shows Plan once the real session swaps in (not the daemon default).
  await expect(page.getByText("start in plan mode").first()).toBeVisible();
  await expect(badge).toContainText("Plan");
});

// --- Facet + permission-monitor as draft settings ---
// Facet and permission-monitor are first-class new-session draft settings (like
// model/thinking). These tests prove: they persist across leave/reopen, a
// plan-facet draft produces a new session whose badge reads "Plan", and a
// default (untouched) draft produces a session with "Execute"/"Bypass+".

test("a draft's facet + permission-monitor survive leaving and reopening", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();

  // Pick non-defaults: Plan facet + Bypass permission.
  await page.getByTestId("facet-badge").click();
  await page.getByRole("option", { name: "Plan" }).click();
  await expect(page.getByTestId("facet-badge")).toHaveText("Plan");

  await page.getByTestId("permission-badge").click();
  const panel = page.getByRole("listbox", { name: "Permission mode" });
  await panel.getByRole("option", { name: /^Bypass[^+]/ }).click();
  await expect(page.getByTestId("permission-badge")).toContainText("Bypass");

  // Navigate to an existing session — exits the draft.
  await row(page, "Explore the fold reducer").click();
  await openSidebar(page);
  await expect(composer(page)).toHaveValue("");

  // Reopen the new-session view — the picks are still there.
  await page.getByRole("button", { name: "New session…" }).click();
  await expect(page.getByTestId("facet-badge")).toHaveText("Plan");
  await expect(page.getByTestId("permission-badge")).toContainText("Bypass");
});

// Facets are dynamic — the daemon derives arbitrary names from facet files, so a
// CUSTOM facet (the mock offers "research" alongside the execute/plan builtins) must
// persist just like the builtins. This guards the bug where persistDraftConfig stored
// any divergent facet but loadDraftConfigMap only re-accepted "execute"/"plan", so a
// custom pick was silently dropped on reload and the draft reverted to Execute.
test("a draft's CUSTOM facet survives leaving/reopening and a reload", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();

  // Pick the custom facet (not a builtin) via the facet badge picker.
  await page.getByTestId("facet-badge").click();
  await page.getByRole("option", { name: "Research" }).click();
  await expect(page.getByTestId("facet-badge")).toHaveText("Research");

  // Navigate to an existing session — exits the draft.
  await row(page, "Explore the fold reducer").click();
  await openSidebar(page);
  await expect(composer(page)).toHaveValue("");

  // Reopen the new-session view (same project) — the custom pick rides draftConfigMap.
  await page.getByRole("button", { name: "New session…" }).click();
  await expect(page.getByTestId("facet-badge")).toHaveText("Research");

  // And survives a full reload: pagehide flushes draftConfigMap to localStorage, boot
  // restores it. Without the fix, loadDraftConfigMap drops "research" and this reverts
  // to "Execute".
  await page.reload();
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();
  await expect(page.getByTestId("facet-badge")).toHaveText("Research");
});

test("submitting a plan-facet draft creates a session whose badge reads Plan", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();

  // Set the draft facet to Plan.
  await page.getByTestId("facet-badge").click();
  await page.getByRole("option", { name: "Plan" }).click();
  await expect(page.getByTestId("facet-badge")).toHaveText("Plan");

  // Submit the draft.
  const draftBox = page.getByPlaceholder("Describe a task or ask a question…");
  await draftBox.fill("start in plan mode please");
  await draftBox.press("Enter");

  // The new session's first snapshot carries facet: "plan" (the mock seed
  // threads it through newSessionSeed), so the badge reads "Plan" on first render.
  await expect(page.getByText("On it — the session's up")).toBeVisible();
  await expect(page.getByTestId("facet-badge")).toHaveText("Plan");
});

test("submitting a default draft creates a session with Execute + Bypass+ badges", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();

  // An untouched draft: facet "Execute", permission "Bypass+" (the daemon default).
  await expect(page.getByTestId("facet-badge")).toHaveText("Execute");
  await expect(page.getByTestId("permission-badge")).toContainText("Bypass+");

  // Submit without changing anything.
  const draftBox = page.getByPlaceholder("Describe a task or ask a question…");
  await draftBox.fill("just a plain session");
  await draftBox.press("Enter");

  // The new session's badges reflect the defaults — no override was applied.
  await expect(page.getByText("On it — the session's up")).toBeVisible();
  await expect(page.getByTestId("facet-badge")).toHaveText("Execute");
  await expect(page.getByTestId("permission-badge")).toContainText("Bypass+");
});
