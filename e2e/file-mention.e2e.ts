import { expect, test, type Page } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

// @-reference autocomplete: files (the original @-file mention), plus the kind-aware
// picker added on top — skills (`@skill:`/`@s:`), subagents (`@subagent:`/`@a:`),
// models (`@model:`/`@m:`), and the sigil rows that narrow a bare/partial query into
// one of those kinds. Prompts stay plain text; the picker only ever inserts a
// canonical `@…` token into the textarea.

const ta = (page: Page) => page.locator(".composer-wrap textarea");
const menu = (page: Page) => page.getByTestId("at-menu");
const row = (page: Page, ref: string) =>
  menu(page).locator(`[data-ref="${ref}"]`);

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("a draft's @-mention searches the draft cwd via the server; a real session doesn't", async ({
  page,
}) => {
  const box = ta(page);

  // A real (focused) session never fires the server fallback — its small index isn't
  // truncated — so the cwd-only marker is absent. The menu stays open with "No matches"
  // (issue #53: always-visible in @-context) rather than hiding entirely.
  await box.click();
  await page.keyboard.type("@DRAFT-CWD");
  await expect(menu(page)).toBeVisible();
  await expect(menu(page)).toContainText("No matches");
  await box.fill("");

  // A new-session draft searches via the server fallback scoped to its target cwd, so the
  // cwd-derived marker appears — and ordinary fixture files still resolve too.
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();
  // The draft renders its own Composer inside the sidebar's .new-session — target that
  // one specifically (the main bottom composer is also still in the DOM).
  const draftBox = page.locator(".new-session .composer-wrap textarea");
  await draftBox.click();
  await page.keyboard.type("@DRAFT-CWD");
  await expect(menu(page)).toBeVisible();
  await expect(
    menu(page).getByText("DRAFT-CWD.md", { exact: false }),
  ).toBeVisible();

  await draftBox.fill("");
  await draftBox.click();
  await page.keyboard.type("@Composer");
  await expect(
    menu(page).getByText("client/src/components/Composer.svelte"),
  ).toBeVisible();
});

test("@skill: lists the available skills; Enter inserts the canonical form", async ({
  page,
}) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@skill:");
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "skill:debug")).toBeVisible();
  await expect(row(page, "skill:journal")).toBeVisible();
  await box.press("Enter");
  await expect(box).toHaveValue("@skill:debug ");
});

test("@s:jou narrows the shorthand to journal only", async ({ page }) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@s:jou");
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "skill:journal")).toBeVisible();
  await expect(row(page, "skill:debug")).toHaveCount(0);
  await box.press("Enter");
  // Canonical form is always the long sigil, regardless of the shorthand typed.
  await expect(box).toHaveValue("@skill:journal ");
});

test("@a: lists the available subagents", async ({ page }) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@a:");
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "subagent:reviewer")).toBeVisible();
  await expect(row(page, "subagent:explorer")).toBeVisible();
  await row(page, "subagent:reviewer").click();
  await expect(box).toHaveValue("@subagent:reviewer ");
});

test("@m: lists the mock models; accepting inserts the canonical provider/modelId", async ({
  page,
}) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@m:");
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "model:anthropic/claude-opus-4-8")).toBeVisible();
  await expect(row(page, "model:anthropic/claude-sonnet-4-6")).toBeVisible();
  await expect(row(page, "model:openai/gpt-5")).toBeVisible();

  // Narrow with the shorthand's partial, then accept — canonical `@model:provider/id`
  // regardless of the `m:` shorthand used to get there.
  await page.keyboard.type("gpt");
  await expect(row(page, "model:openai/gpt-5")).toBeVisible();
  await expect(row(page, "model:anthropic/claude-opus-4-8")).toHaveCount(0);
  await box.press("Enter");
  await expect(box).toHaveValue("@model:openai/gpt-5 ");
});

test("@sk shows the skill: sigil row after file matches; accepting it narrows into the skill list", async ({
  page,
}) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@sk");
  await expect(menu(page)).toBeVisible();
  // "docs/ADR-desktop-shell.md" contains "sk" (deSKtop) — a genuine file match — and
  // the skill: sigil is offered right after it (sigils always sort last).
  await expect(row(page, "file:docs/ADR-desktop-shell.md")).toBeVisible();
  const sigil = row(page, "sigil:skill:");
  await expect(sigil).toBeVisible();

  // Enter accepts the highlighted row; arrow down to the sigil (it's the last row).
  const count = await menu(page).locator("[data-ref]").count();
  for (let i = 0; i < count - 1; i++) await box.press("ArrowDown");
  await box.press("Enter");
  await expect(box).toHaveValue("@skill:");
  // The menu recomputed to the skill kind's full list — same keep-narrowing mechanic
  // as a directory "/".
  await expect(row(page, "skill:debug")).toBeVisible();
  await expect(row(page, "skill:journal")).toBeVisible();
});

test("Escape dismisses the @-reference menu without changing the draft", async ({
  page,
}) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@skill:");
  await expect(menu(page)).toBeVisible();
  await box.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await expect(box).toHaveValue("@skill:");
});

test("[ ] adjust a selected model row's reasoning level; accepting appends (level)", async ({
  page,
}) => {
  const box = ta(page);
  await box.click();
  // Narrow to the single leveled model claude-sonnet-4-6 (mock fixture:
  // thinkingLevels off/low/medium/high — server-rs/pantoken-server/src/mock_driver.rs).
  await page.keyboard.type("@m:sonnet");
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "model:anthropic/claude-sonnet-4-6")).toBeVisible();

  // No level chosen yet — no "reasoning:" text on the row.
  await expect(
    row(page, "model:anthropic/claude-sonnet-4-6"),
  ).not.toContainText("reasoning:");

  // ] steps up from unset: null -> "off".
  await box.press("]");
  await expect(row(page, "model:anthropic/claude-sonnet-4-6")).toContainText(
    "reasoning: off",
  );
  // ] again: "off" -> "low".
  await box.press("]");
  await expect(row(page, "model:anthropic/claude-sonnet-4-6")).toContainText(
    "reasoning: low",
  );
  // [ steps back down: "low" -> "off".
  await box.press("[");
  await expect(row(page, "model:anthropic/claude-sonnet-4-6")).toContainText(
    "reasoning: off",
  );

  await box.press("Enter");
  await expect(box).toHaveValue("@model:anthropic/claude-sonnet-4-6(off) ");
});

test("] clamps at the top level of a single-level model instead of wrapping", async ({
  page,
}) => {
  const box = ta(page);
  await box.click();
  // deepseek-v4-flash's only thinking level is "off" (mock fixture).
  await page.keyboard.type("@m:deepseek");
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "model:deepseek/deepseek-v4-flash")).toBeVisible();

  await box.press("]");
  await expect(row(page, "model:deepseek/deepseek-v4-flash")).toContainText(
    "reasoning: off",
  );
  // A second ] clamps at the top instead of wrapping back to unset.
  await box.press("]");
  await expect(row(page, "model:deepseek/deepseek-v4-flash")).toContainText(
    "reasoning: off",
  );
  // [ steps back past the only level, to unset — the reasoning text disappears.
  await box.press("[");
  await expect(row(page, "model:deepseek/deepseek-v4-flash")).not.toContainText(
    "reasoning:",
  );

  await box.press("Enter");
  // No level chosen at accept time — the terminal model gets the standard trailing space.
  await expect(box).toHaveValue("@model:deepseek/deepseek-v4-flash ");
  expect(
    await box.evaluate((el: HTMLTextAreaElement) => ({
      selectionStart: el.selectionStart,
      selectionEnd: el.selectionEnd,
    })),
  ).toEqual({ selectionStart: 34, selectionEnd: 34 });
});

test("[ and ] on a non-model row type the character into the draft instead of being swallowed", async ({
  page,
}) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@skill:");
  await expect(menu(page)).toBeVisible();
  // The first skill row ("debug") is highlighted by default — a skill row, not a
  // model row, so [ ] must NOT be intercepted for reasoning-level stepping.
  await expect(row(page, "skill:debug")).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await box.press("[");
  await expect(box).toHaveValue("@skill:[");
  await box.press("]");
  await expect(box).toHaveValue("@skill:[]");
});

// External paths (`@~/`, `@/`, `@../`) browse the server's filesystem OUTSIDE the
// project — the mock's synthetic external tree (server-rs/pantoken-server/src/mock_driver.rs
// `mock_external_tree()`), not the local file index. Every case here always round-trips
// through the debounced server query (Composer.svelte's always-fire-for-external effect),
// so assertions rely on Playwright's auto-retrying `expect` rather than a fixed wait.
// Keyboard accepts throughout — mouse accepts have a known cursor-resync quirk.

test("@~/ lists the synthetic external home — dirs first, hidden dotfile absent", async ({
  page,
}) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@~/");
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "file:~/projects")).toBeVisible();
  await expect(row(page, "file:~/notes.md")).toBeVisible();
  await expect(row(page, "file:~/todo.txt")).toBeVisible();
  await expect(row(page, "file:~/.secrets")).toHaveCount(0);
});

test("@~/proj narrows to the projects/ directory only", async ({ page }) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@~/proj");
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "file:~/projects")).toBeVisible();
  await expect(row(page, "file:~/notes.md")).toHaveCount(0);
  await expect(row(page, "file:~/todo.txt")).toHaveCount(0);
});

test("keyboard-accepting projects/ drills down; accepting readme.md completes the path", async ({
  page,
}) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@~/proj");
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "file:~/projects")).toBeVisible();

  // Only "~/projects" matches "proj" — it's the sole (and default-highlighted) row.
  await box.press("Enter");
  await expect(box).toHaveValue("@~/projects/");

  // The menu recomputed to `~/projects`'s children — same keep-narrowing mechanic as a
  // project-mode directory `/`.
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "file:~/projects/blog")).toBeVisible();
  await expect(row(page, "file:~/projects/pantoken")).toBeVisible();
  await expect(row(page, "file:~/projects/readme.md")).toBeVisible();

  // Dirs sort first, alphabetically (blog, pantoken), then the file (readme.md) —
  // arrow down twice from the default-highlighted first row to reach it.
  await box.press("ArrowDown");
  await box.press("ArrowDown");
  await box.press("Enter");
  await expect(box).toHaveValue("@~/projects/readme.md ");
});

test("@../ lists the parent-relative fixtures", async ({ page }) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@../");
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "file:../sibling-project")).toBeVisible();
  await expect(row(page, "file:../NOTES.md")).toBeVisible();
});

test("@/etc/ lists the root-anchored fixture", async ({ page }) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@/etc/");
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "file:/etc/hosts")).toBeVisible();
});

// Shift+Tab ignore-rules toggle (polytoken TUI parity): while the picker is open, it
// reveals hidden dotfiles and gitignored entries in BOTH project and external modes.
// The mock's `.env`/`dist/bundle.js` (project) and `~/.secrets` (external) fixtures are
// deliberately absent from the always-visible lists so the toggle has something of its
// own to reveal (server-rs/pantoken-server/src/mock_driver.rs `mock_ignored_files()` /
// `mock_external_tree()`).

test("project mode: a query matching only a hidden fixture shows nothing until Shift+Tab reveals it, and again to hide it", async ({
  page,
}) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@.env");
  // Zero local matches: `.env` is a path-prefix match for the hidden `.env` fixture,
  // but under the fuzzy subsequence matcher (#63) it matches no visible fixture — no
  // visible path starts with `.` (so the `.`→`e`→`n`→`v` subsequence can't anchor).
  // The menu stays open with "No matches" (issue #53: always-visible in @-context,
  // so the footer/hotkeys — including ⇧Tab — are reachable without a "surprise"
  // reveal). This is the case Shift+Tab must work from: the menu is already open.
  await expect(menu(page)).toBeVisible();
  await expect(menu(page)).toContainText("No matches");

  await box.press("Shift+Tab");
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "file:.env")).toBeVisible();
  await expect(menu(page)).toContainText("ignored files shown");
  // Coexist (issue #19): the ignore-toggle consumed Shift+Tab, so the facet
  // must NOT have also rotated.
  await expect(page.getByTestId("facet-badge")).toHaveText("Execute");

  // Shift+Tab again hides it — back to zero matches, menu still open with "No matches".
  await box.press("Shift+Tab");
  await expect(menu(page)).toBeVisible();
  await expect(menu(page)).toContainText("No matches");
});

test("@~/ then Shift+Tab reveals the hidden ~/.secrets fixture; Shift+Tab again hides it", async ({
  page,
}) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@~/");
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "file:~/.secrets")).toHaveCount(0);
  await expect(menu(page)).toContainText("⇧Tab ignored files");

  await box.press("Shift+Tab");
  await expect(row(page, "file:~/.secrets")).toBeVisible();
  await expect(menu(page)).toContainText("ignored files shown");
  // Coexist (issue #19): the ignore-toggle consumed Shift+Tab, so the facet
  // must NOT have also rotated.
  await expect(page.getByTestId("facet-badge")).toHaveText("Execute");

  await box.press("Shift+Tab");
  await expect(row(page, "file:~/.secrets")).toHaveCount(0);
});

// Issue #53: the @-menu is always visible while the cursor is inside an @-token, even
// when the query matches nothing — showing a "No matches" body and the pinned hotkey
// footer, so there's no "surprise Shift+Tab" from a hidden menu.

test("menu stays open with 'No matches' when a project query matches nothing", async ({
  page,
}) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@zzz");
  await expect(menu(page)).toBeVisible();
  await expect(menu(page)).toContainText("No matches");
  // The footer/hotkeys stay visible below the empty body.
  await expect(menu(page)).toContainText("↑↓ navigate");
  // Escape dismisses the always-open empty menu.
  await box.press("Escape");
  await expect(menu(page)).toHaveCount(0);
});

test("menu stays open with 'No matches' in a takeover mode", async ({ page }) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@model:zzz");
  await expect(menu(page)).toBeVisible();
  await expect(menu(page)).toContainText("No matches");
  await expect(menu(page)).toContainText("↑↓ navigate");
});

test("Enter on an empty @-menu falls through to submit (does not swallow)", async ({
  page,
}) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@zzz");
  await expect(menu(page)).toContainText("No matches");
  // Enter must NOT be swallowed by the empty menu — it falls through to normal
  // submit. The draft (with the literal @zzz) is sent: the composer clears and
  // the prompt text appears in the transcript, ending the @-context.
  await box.press("Enter");
  await expect(box).toHaveValue("");
  await expect(page.getByText("@zzz").first()).toBeVisible();
  await expect(menu(page)).toHaveCount(0);
});

test("ArrowUp/ArrowDown on an empty @-menu is a no-op (no crash, menu stays open)", async ({
  page,
}) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@zzz");
  await expect(menu(page)).toContainText("No matches");
  await box.press("ArrowDown");
  await expect(menu(page)).toBeVisible();
  await expect(menu(page)).toContainText("No matches");
  await box.press("ArrowUp");
  await expect(menu(page)).toBeVisible();
  await expect(menu(page)).toContainText("No matches");
});

test("skill/subagent/model rows render a front kind: prefix; no right-edge badge", async ({
  page,
}) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@skill:");
  await expect(menu(page)).toBeVisible();
  // The skill row's visible text starts with the front "skill:" prefix (mirroring the
  // search term), and the old right-edge .kind-badge is gone.
  await expect(row(page, "skill:debug")).toContainText("skill:debug");
  await expect(menu(page).locator(".kind-badge")).toHaveCount(0);

  await box.fill("");
  await box.click();
  await page.keyboard.type("@a:");
  await expect(row(page, "subagent:reviewer")).toContainText("subagent:reviewer");
  await expect(menu(page).locator(".kind-badge")).toHaveCount(0);

  await box.fill("");
  await box.click();
  await page.keyboard.type("@m:");
  // Model rows show "model:provider/modelId" at the front.
  await expect(row(page, "model:openai/gpt-5")).toContainText("model:openai/gpt-5");
  await expect(menu(page).locator(".kind-badge")).toHaveCount(0);
});

test("model rows keep the friendly label as muted secondary text", async ({ page }) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@m:");
  await expect(menu(page)).toBeVisible();
  // claude-opus-4-8's mock fixture carries a friendly label distinct from its modelId.
  // The row shows the front "model:" prefix + provider/modelId, with the label as
  // secondary .meta text.
  const modelRow = row(page, "model:anthropic/claude-opus-4-8");
  await expect(modelRow).toContainText("model:anthropic/claude-opus-4-8");
  await expect(modelRow.locator(".meta")).toBeVisible();
});

test("pinned footer stays visible when scrolling the list to the top", async ({
  page,
}) => {
  const box = ta(page);
  await box.click();
  // `@s` matches enough skills + files to overflow the menu's max-height, so the
  // list scrolls. The footer is pinned outside the scroll region and must remain
  // visible at both the bottom and the top of the scroll range — if it were inside
  // the scroll area (the old layout), scrolling down would push it out of view.
  await page.keyboard.type("@s");
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).locator("[data-ref]").first()).toBeVisible();
  const list = menu(page).locator(".list");
  // Scroll to the bottom first — the footer must still be visible there.
  await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(menu(page).getByText("↑↓ navigate")).toBeVisible();
  // Then scroll back to the top — the footer must still be visible there too.
  await list.evaluate((el) => (el.scrollTop = 0));
  await expect(menu(page).getByText("↑↓ navigate")).toBeVisible();
});

test("plain Tab still accepts the highlighted row after Shift+Tab has toggled ignored files on", async ({
  page,
}) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@~/");
  await expect(menu(page)).toBeVisible();

  // Shift+Tab toggles the ignore state without accepting anything — the draft stays put.
  await box.press("Shift+Tab");
  await expect(row(page, "file:~/.secrets")).toBeVisible();
  await expect(box).toHaveValue("@~/");

  // Dirs sort first ("~/projects"), then dotfile-then-alpha files: ~/.secrets, ~/notes.md,
  // ~/todo.txt — arrow down once from the default-highlighted first row to reach .secrets,
  // then accept with plain (unshifted) Tab.
  await box.press("ArrowDown");
  await box.press("Tab");
  await expect(box).toHaveValue("@~/.secrets ");
});

test("Shift+Tab in a skill takeover opens the facet menu (no toggle, no accept, no rotation)", async ({
  page,
}) => {
  // Skill/subagent/model takeovers have no notion of "ignored files", so the footer
  // omits the ⇧Tab hint and the ignore-toggle doesn't apply. Shift+Tab now opens
  // the facet menu on the current facet (no rotation, no commit) instead of
  // falling through to browser focus-nav (issue #50). The draft text is
  // unchanged — no accept happened.
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toHaveText("Execute");

  const box = ta(page);
  await box.click();
  await page.keyboard.type("@skill:");
  await expect(menu(page)).toBeVisible();
  await expect(menu(page)).not.toContainText("⇧Tab");

  await box.press("Shift+Tab");
  // Not accepted (the draft would read "@skill:debug"), not modified at all…
  await expect(box).toHaveValue("@skill:");
  // …and the facet menu opened (no rotation — badge still "Execute").
  await expect(badge).toHaveText("Execute");
  const panel = page.getByRole("listbox", { name: "Facet" });
  await expect(panel).toBeVisible();

  // Close the facet menu — Escape aborts without changing the facet.
  await page.keyboard.press("Escape");
  await expect(panel).not.toBeVisible();
  await expect(badge).toHaveText("Execute");
});

test("Escape still dismisses the menu after the ignore toggle has been used", async ({
  page,
}) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@~/");
  await expect(menu(page)).toBeVisible();
  await box.press("Shift+Tab");
  await expect(row(page, "file:~/.secrets")).toBeVisible();

  await box.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await expect(box).toHaveValue("@~/");
});

// Stale-while-revalidate (issue #17): when typing narrows a server-backed query, the
// menu must NOT blank out and reappear on every keystroke. It should keep showing the
// previous results, re-filtered against the new query, until fresh server results arrive.
// The mock driver's list_files is synchronous, so we intercept the WS `fileList` frame
// and hold it to make the in-flight window observable.
test("no flicker: narrowing @~/p keeps re-filtered rows visible during the in-flight window", async ({
  page,
}) => {
  // A flag the WS handler reads to decide whether to delay fileList responses. Toggled
  // from the test to gate the in-flight window.
  let delayFileList = false;
  // Stored in an array so TS doesn't narrow the type to `never` (the assignment happens
  // inside the routeWebSocket closure, which TS's control-flow analysis can't track).
  const pendingFileList: Array<() => void> = [];

  // Install BEFORE navigation: routeWebSocket patches the page's WebSocket at document init.
  await page.routeWebSocket(/./, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      const data = message as string;
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === "fileList" && delayFileList) {
          // Hold the response until the test releases it.
          pendingFileList.push(() => ws.send(data));
          return;
        }
      } catch {
        // non-JSON — forward untouched
      }
      ws.send(data);
    });
    ws.onMessage((message) => server.send(message as string));
  });

  await gotoFresh(page);
  const box = ta(page);
  await box.click();

  // Type @~/p — the first response arrives (no delay yet), showing ~/projects.
  await page.keyboard.type("@~/p");
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "file:~/projects")).toBeVisible();
  await expect(row(page, "file:~/notes.md")).toHaveCount(0);

  // Now arm the delay so the NEXT keystroke's response is held in-flight.
  delayFileList = true;

  // Type "r" → @~/pr. The fresh response is held, but the stale-while-revalidate cache
  // re-filters the previous results by "pr" — ~/projects still matches, so the menu
  // stays visible with a non-zero row count.
  await page.keyboard.type("r");
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "file:~/projects")).toBeVisible();

  // Release the held response — fresh results arrive and replace the stale-filtered display.
  delayFileList = false;
  for (const send of pendingFileList.splice(0)) send();
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "file:~/projects")).toBeVisible();
});
