import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

/** Open the project chip's directory browser and choose `/Users/timo/src/<name>`. The
 *  picker opens at the active fixture session's cwd (`/Users/timo/src/pilot` — a stable
 *  path regardless of the suite's $HOME), so we step up to `.../src` and into `name`. */
async function chooseProjectDir(
  page: import("@playwright/test").Page,
  name: string,
): Promise<void> {
  await page.locator(".chips .chip").first().click();
  const picker = page.getByTestId("dir-picker");
  await expect(picker).toBeVisible();
  await picker.locator(".row.up").click(); // /Users/timo/src/pilot -> /Users/timo/src
  await picker.locator(".row[data-i]", { hasText: name }).click(); // -> .../<name>
  await picker.locator(".use").click();
  await expect(picker).toBeHidden();
}

test("the sidebar groups sessions by project and switches the active one", async ({
  page,
}) => {
  // the header shows the active (greeting) session's title
  await expect(page.locator("header .title")).toContainText(
    "Wire up the WebSocket bridge",
  );

  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");
  // scope to the session list so we match project-group headers, not the
  // "pilot" that also shows up as the header subtitle / composer placeholder
  const list = sidebar.locator(".list");

  // sessions are grouped under their project dir (basename of cwd)
  await expect(list.getByText("pilot", { exact: true })).toBeVisible();
  await expect(list.getByText("scratch", { exact: true })).toBeVisible();

  // the other mock sessions are listed (one named, one preview-only)
  await expect(sidebar.getByText("Explore the fold reducer")).toBeVisible();
  await expect(sidebar.getByText("quick scratch session")).toBeVisible();

  // switching swaps the transcript to the chosen session's history
  await sidebar.getByText("Explore the fold reducer").click();
  await expect(
    page.getByText("How does foldEvent assemble the transcript?"),
  ).toBeVisible();
  // and the previous session's content is gone
  await expect(page.getByText("Add a /health route to the server")).toHaveCount(
    0,
  );
  // the header now reflects the switched-to session
  await expect(page.locator("header .title")).toContainText(
    "Explore the fold reducer",
  );
});

test("an empty launch restores this client's last-focused session", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByText("Explore the fold reducer").click();
  await expect(page.locator("header .title")).toContainText(
    "Explore the fold reducer",
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.entries(localStorage).some(
          ([key, value]) =>
            key.startsWith("pilot.lastSession.") && value === "older-session",
        ),
      ),
    )
    .toBe(true);

  // Leave the server on the same empty landing as the real driver after a restart,
  // while retaining its stable identity + on-disk session list.
  await page.request.get("/debug/reset?bootstrap=0");
  await page.reload();

  await expect(page.locator("header .title")).toContainText(
    "Explore the fold reducer",
  );
  await expect(
    page.getByText("How does foldEvent assemble the transcript?"),
  ).toBeVisible();
});

test("a stale last-focused session falls back to the home draft", async ({
  page,
}) => {
  const key = await page.evaluate(() => {
    const found = Object.keys(localStorage).find((k) =>
      k.startsWith("pilot.lastSession."),
    );
    if (!found) throw new Error("last-session preference was not persisted");
    localStorage.setItem(found, "missing-session");
    return found;
  });

  await page.request.get("/debug/reset?bootstrap=0");
  await page.reload();

  await expect(
    page.getByPlaceholder("Describe a task or ask a question…"),
  ).toBeVisible();
  expect(await page.evaluate((k) => localStorage.getItem(k), key)).toBeNull();
});

test("a pilot-created worktree session groups under its parent project, interleaved by recency", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");
  // Start a new session in a worktree of the pilot project (the active session's cwd is
  // the pilot repo). The mock isolates it as a sibling "-worktree" dir.
  await sidebar.getByText("New session…").click();
  await page.getByRole("button", { name: "worktree" }).click();
  const composer = page.getByPlaceholder("Describe a task or ask a question…");
  await composer.fill("isolate me");
  await composer.press("Enter");

  await openSidebar(page);
  const list = sidebar.locator(".list");

  // The worktree session (cwd /Users/timo/src/pilot-worktree) groups under its PARENT
  // project (the pilot repo, its `base`) — NOT a separate "pilot-worktree" group.
  await expect(list.getByText("pilot-worktree", { exact: true })).toHaveCount(
    0,
  );

  const pilotGroup = list
    .locator(".group")
    .filter({ has: page.locator(".proj", { hasText: "pilot" }) });
  // The new worktree session is the newest (just created), so it sits atop the pilot
  // group — interleaved by recency with the main-tree sessions, not segregated into
  // its own group. The row carries the worktree badge.
  const firstRow = pilotGroup.locator("li.row-wrap").first();
  await expect(firstRow.locator(".wt")).toBeVisible();
  // The main-tree sessions remain in the same group beneath it.
  await expect(
    pilotGroup.getByText("Wire up the WebSocket bridge"),
  ).toBeVisible();
  await expect(pilotGroup.getByText("Explore the fold reducer")).toBeVisible();
});

test("rows show a relative last-activity timestamp; the count appears only when collapsed", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  // Each row carries a compact "time since last activity" label at the end of its line
  // (the unified status slot resolves to the timestamp when the session is idle/read).
  const demoRow = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Wire up the WebSocket" });
  await expect(demoRow.locator(".time")).toHaveText(
    /^(\d+(m|h|d|w|mo|y)|now)$/,
  );

  // The session count is hidden while a group is expanded…
  const pilotGroup = sidebar
    .locator(".group")
    .filter({ has: page.locator(".proj", { hasText: "pilot" }) });
  await expect(pilotGroup.locator(".count")).toHaveCount(0);

  // …and revealed once it's collapsed (the rows themselves disappear).
  await pilotGroup.locator(".group-toggle").click();
  await expect(pilotGroup.locator(".count")).toBeVisible();
  await expect(demoRow).toHaveCount(0);
});

test("relative timestamps tick forward as time passes", async ({ page }) => {
  // Freeze the clock before the app boots so the label is stable, then advance it and
  // assert the minute count climbs — proving the timestamp re-renders, not just stamps once.
  await page.clock.install();
  await gotoFresh(page);
  await openSidebar(page);

  const time = page
    .getByTestId("sidebar")
    .locator(".row-wrap")
    .filter({ hasText: "Wire up the WebSocket" })
    .locator(".time");
  const minutes = async (): Promise<number> => {
    const m = (await time.textContent())?.match(/^(\d+)m$/);
    if (!m) throw new Error(`expected "Nm", got "${await time.textContent()}"`);
    return Number(m[1]);
  };

  const before = await minutes();
  await page.clock.runFor(5 * 60_000); // five minutes, firing the 1-minute interval
  await expect(time).toHaveText(`${before + 5}m`);
});

test("a project's + button opens a new-session draft for that dir", async ({
  page,
}) => {
  await openSidebar(page);
  await page
    .getByTestId("sidebar")
    .getByRole("button", { name: "New session in pilot" })
    .click();
  // Deferred creation: the draft hero shows (nothing is created until you send), and
  // it's prefilled with that group's dir + the default model.
  const hero = page.getByTestId("new-session");
  await expect(hero).toBeVisible();
  await expect(hero).toContainText("/Users/timo/src/pilot");
  await expect(
    page.getByText("Nothing is created until you send"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Claude Opus 4\.8/ }),
  ).toBeVisible();
});

test("a session can be started in a directory chosen via the browser", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  await sidebar.getByText("New session…").click();
  // The project lives as a chip in the composer; click it to browse for the directory.
  await chooseProjectDir(page, "elsewhere");
  // Sending the first prompt is what actually creates the session (atomic).
  const composer = page.getByPlaceholder("Describe a task or ask a question…");
  await composer.fill("kick things off");
  await composer.press("Enter");

  // A new project group appears for the chosen dir.
  await openSidebar(page); // (closed by afterNavigate on the mobile drawer)
  await expect(
    page.getByTestId("sidebar").getByText("elsewhere", { exact: true }),
  ).toBeVisible();
});

test("a project group's session list is a plain, un-capped list", async ({
  page,
}) => {
  await openSidebar(page);
  const ul = page.getByTestId("sidebar").locator(".group ul").first();
  await expect(ul).toBeVisible();
  // Plain list: no per-group height cap or inner scroll — the whole sidebar list
  // scrolls instead, and archiving keeps the length manageable.
  const styles = await ul.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { overflowY: cs.overflowY, maxHeight: cs.maxHeight };
  });
  expect(styles.overflowY).toBe("visible");
  expect(styles.maxHeight).toBe("none");
});

test("the session search filters by name, preview, and path", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");
  const search = sidebar.getByPlaceholder("Search sessions…");

  // name match: "fold" → only "Explore the fold reducer"
  await search.fill("fold");
  await expect(sidebar.getByText("Explore the fold reducer")).toBeVisible();
  await expect(sidebar.getByText("Wire up the WebSocket bridge")).toHaveCount(
    0,
  );
  await expect(sidebar.getByText("quick scratch session")).toHaveCount(0);

  // path match: "scratch" → the session whose cwd ends in /scratch
  await search.fill("scratch");
  await expect(sidebar.getByText("quick scratch session")).toBeVisible();
  await expect(sidebar.getByText("Explore the fold reducer")).toHaveCount(0);

  // clearing restores every session
  await search.fill("");
  await expect(sidebar.getByText("Explore the fold reducer")).toBeVisible();
  await expect(sidebar.getByText("quick scratch session")).toBeVisible();
});

test("search Enter opens the top match; Esc clears the query", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");
  const search = sidebar.getByPlaceholder("Search sessions…");

  // Filter to a single match, then Enter opens it (becomes the active row). Assert the
  // single-match premise explicitly so a future fixture that adds another "fold" session
  // doesn't silently weaken this into "Enter opens *some* row".
  await search.fill("fold");
  await expect(sidebar.locator(".row-wrap")).toHaveCount(1);
  await search.press("Enter");
  await expect(sidebar.locator(".row.active")).toContainText(
    "Explore the fold reducer",
  );

  // Esc on a non-empty query clears it (and restores the full list) rather than closing.
  await search.fill("fold");
  await expect(sidebar.getByText("Wire up the WebSocket bridge")).toHaveCount(
    0,
  );
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(sidebar.getByText("Wire up the WebSocket bridge")).toBeVisible();
});

test("reopening the sidebar focuses the search box (desktop)", async ({
  page,
}) => {
  await openSidebar(page);
  const search = page
    .getByTestId("sidebar")
    .getByPlaceholder("Search sessions…");

  // Close, then reopen — the closed→open transition lands focus in the search box so a
  // keyboard user can filter immediately. (On a phone this is suppressed; desktop only.)
  await page.getByTestId("sidebar-toggle").click();
  await expect(page.getByTestId("sidebar")).toHaveAttribute(
    "data-open",
    "false",
  );
  await page.getByTestId("sidebar-toggle").click();
  await expect(search).toBeFocused();
});

test("clicking the project chip opens the directory browser", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByTestId("sidebar").getByText("New session…").click();
  await page.locator(".chips .chip").first().click();
  // The chip opens a server-side directory browser (the full browse/pick flow lives in
  // dir-picker.e2e.ts); here we only assert the chip is what surfaces it.
  await expect(page.getByTestId("dir-picker")).toBeVisible();
});

test("the worktree chip creates the session in an isolated worktree dir, grouped under its parent project", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");
  await sidebar.getByText("New session…").click();
  // Toggle the worktree chip on, then choose the project via the directory browser.
  await page.getByRole("button", { name: "worktree" }).click();
  await expect(page.getByRole("button", { name: "worktree" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await chooseProjectDir(page, "demo");
  // Sending the first prompt creates the session.
  const composer = page.getByPlaceholder("Describe a task or ask a question…");
  await composer.fill("get started");
  await composer.press("Enter");

  // The mock isolates a worktree request as a sibling "-worktree" dir, but the session
  // groups under its PARENT project ("demo") — not its own worktree-basename group —
  // and the isolated path shows in the worktree badge's tooltip.
  await openSidebar(page);
  const list = sidebar.locator(".list");
  await expect(list.getByText("demo", { exact: true })).toBeVisible();
  await expect(list.getByText("demo-worktree", { exact: true })).toHaveCount(0);
  const badge = list.locator(".wt");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute(
    "title",
    "Worktree: /Users/timo/src/demo-worktree",
  );
});

// Create a worktree-backed session at /Users/timo/src/demo (→ demo-worktree) and leave
// the sidebar open. Shared by the indicator/cleanup specs below.
async function createWorktreeSession(page: import("@playwright/test").Page) {
  await openSidebar(page);
  await page.getByTestId("sidebar").getByText("New session…").click();
  await page.getByRole("button", { name: "worktree" }).click();
  await chooseProjectDir(page, "demo");
  const composer = page.getByPlaceholder("Describe a task or ask a question…");
  await composer.fill("get started");
  await composer.press("Enter");
  await openSidebar(page);
}

test("a worktree session shows a path indicator and can be cleaned up", async ({
  page,
}) => {
  await createWorktreeSession(page);
  const sidebar = page.getByTestId("sidebar");

  // The indicator carries the worktree path in its tooltip.
  const badge = sidebar.locator(".wt");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute(
    "title",
    "Worktree: /Users/timo/src/demo-worktree",
  );

  // Clean it up from the row's ⋯ menu (two-step confirm), then the indicator is gone.
  const row = sidebar
    .locator("li.row-wrap")
    .filter({ has: page.locator(".wt") });
  await row.getByTestId("session-menu").click();
  await page.getByTestId("cleanup-worktree").click();
  await page.getByTestId("confirm-cleanup-worktree").click();
  await expect(sidebar.locator(".wt")).toHaveCount(0);
});

test("archiving a worktree session reaps the worktree", async ({ page }) => {
  await createWorktreeSession(page);
  const sidebar = page.getByTestId("sidebar");

  const row = sidebar
    .locator("li.row-wrap")
    .filter({ has: page.locator(".wt") });
  await row.getByTestId("session-menu").click();
  await sidebar.getByRole("menuitem", { name: "Archive" }).click();

  // Reveal archived sessions; the row is back but the worktree indicator is gone — the
  // (clean) worktree was reaped on archive.
  await sidebar.getByTestId("filter-toggle").click();
  await expect(
    sidebar.getByText("demo-worktree", { exact: true }),
  ).toBeVisible();
  await expect(sidebar.locator(".wt")).toHaveCount(0);
});
