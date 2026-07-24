import { expect, type Page } from "@playwright/test";

/** Reset the mock to the initial fixture, load the app in dev mode, and wait for
 *  the greeting conversation to finish replaying so assertions start from a known
 *  state. */
export async function gotoFresh(page: Page): Promise<void> {
  await page.request.get("/debug/reset");
  // Clear persisted scroll positions before the app boots so each test starts clean:
  // localStorage survives a same-origin navigation, so a prior test's saved reading
  // position would otherwise boot-restore the greeting to a stale spot AND leak into
  // session-switch assertions. Scoped to this one key (drafts/theme/etc. persist).
  // addInitScript runs before each navigation in this page's lifetime — once per test,
  // no extra reload.
  page.addInitScript(() => localStorage.removeItem("pantoken.scrollPositions"));
  await page.goto("/?dev");
  // The final text starts rendering before the fixture emits runCompleted. Wait for
  // the settled work block instead: its appearance proves the turn finished and the
  // live inline content has completed its collapse/reflow.
  await waitForSettledWorkBlocks(page, 1);
}

/** Click one of the dev-bar buttons that drives the mock to a named UI state. */
export async function drive(page: Page, script: string): Promise<void> {
  await page.getByRole("button", { name: script, exact: true }).click();
}

/** Wait until `count` tool-bearing turns have settled and collapsed their work.
 *  This is stronger than waiting for final response text, which appears mid-stream. */
export async function waitForSettledWorkBlocks(
  page: Page,
  count: number,
): Promise<void> {
  const toggles = page.getByTestId("work-toggle");
  await expect(toggles).toHaveCount(count);
  await expect(toggles.last()).toContainText("Worked for");
  await expect(toggles.last()).toHaveAttribute("aria-expanded", "false");
}

/** Expand a settled turn's collapsible "Worked for Ns" block so its tools + intermediate
 *  narration render. Settled turns collapse that section by default; tests that assert on
 *  working-step content must reveal it first. Targets the most recent turn's block by
 *  default (pass "first" for the earliest, e.g. the greeting when later turns exist). */
export async function expandWork(
  page: Page,
  which: "first" | "last" = "last",
): Promise<void> {
  const toggles = page.getByTestId("work-toggle");
  const toggle = which === "first" ? toggles.first() : toggles.last();
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.click();
}

/** Open Settings and optionally choose a section through the current navigation
 *  (desktop rail or phone index). Only the chosen detail renders. */
export async function openSettings(
  page: Page,
  section?:
    | "appearance"
    | "notifications"
    | "models"
    | "environment"
    | "mcp"
    | "token"
    | "computers",
): Promise<void> {
  const settings = page.getByTestId("settings-toggle");
  if (
    (await page.getByTestId("sidebar").getAttribute("data-open")) !== "true"
  )
    await openSidebar(page);
  await settings.click();
  if (section) await page.getByTestId(`settings-tab-${section}`).click();
}

/** Ensure the session sidebar is open. Desktop opens by default; the phone view
 *  needs the header's leading-edge panel icon (the header hamburger was removed — this is now
 *  the only click affordance, besides ⌘B). Driven off `data-open` (the view stays
 *  mounted off-screen, so visibility checks are unreliable). */
export async function openSidebar(page: Page): Promise<void> {
  const sidebar = page.getByTestId("sidebar");
  // A just-changed viewport can briefly toggle the sidebar state: on phone→desktop
  // the sidebarOpen getter switches from mobileView to the persisted desktop
  // preference, which may open or close it. Wait one frame for the resize handler
  // to settle before deciding whether the button is needed, so it doesn't detach
  // mid-click.
  await page.waitForTimeout(50);
  if ((await sidebar.getAttribute("data-open")) !== "true")
    await page.getByTestId("sidebar-open").click();
  await expect(sidebar).toHaveAttribute("data-open", "true");
}

/** Ensure the right context panel (flagged files, background jobs, todos) is open.
 *  The header `context-open` entry is always visible when the panel is closed and
 *  not drafting, so this clicks it directly.
 *
 *  Must not be called during a draft — `context-open` is hidden while drafting
 *  (use the `⌘⇧J` hotkey via keyboard instead). */
export async function openRightSidebar(page: Page): Promise<void> {
  const panel = page.getByTestId("right-sidebar");
  if ((await panel.getAttribute("data-open")) !== "true") {
    await page.getByTestId("context-open").click();
  }
  await expect(panel).toHaveAttribute("data-open", "true");
}

/** Open the project menu and choose `/Users/timo/src/<name>` via the DirPicker. */
export async function chooseProjectDir(page: Page, name: string): Promise<void> {
  await page.getByTestId("draft-project-control").click();
  await page.getByTestId("project-menu").getByText("New project…").click();
  await page.mouse.move(0, 0);
  const picker = page.getByTestId("dir-picker");
  await expect(picker).toBeVisible();
  const input = picker.getByLabel("Project directory path");
  await input.fill(`/Users/timo/src/${name}/`);
  await expect(picker.getByTestId("use-current-directory")).toBeVisible();
  await picker.getByTestId("use-current-directory").click();
  await expect(picker).toBeHidden();
}

/** Create a worktree-backed session at /Users/timo/src/<project>
 *  and leave the sidebar open. `project="dirty"` simulates uncommitted changes so
 *  archive keeps the worktree + emits `worktreeRetained`. */
export async function createWorktreeSession(
  page: Page,
  project = "demo",
): Promise<void> {
  await openSidebar(page);
  await page
    .getByTestId("sidebar")
    .getByTestId("sidebar-new-session")
    .getByText("New session")
    .click();
  await page.getByRole("button", { name: "worktree" }).click();
  await chooseProjectDir(page, project);
  const composer = page.getByPlaceholder("Describe a task or ask a question…");
  await composer.fill("get started");
  await composer.press("Enter");
  await openSidebar(page);
}

/** Archive a session row via its right-click context menu. */
export async function archiveRow(page: Page, rowText: string): Promise<void> {
  const sidebar = page.getByTestId("sidebar");
  const row = sidebar.locator(".row-wrap").filter({ hasText: rowText });
  await expect(row).toBeVisible();
  await row.locator(".row").click({ button: "right" });
  await sidebar.getByRole("menuitem", { name: "Archive", exact: true }).click();
}

/** Simulate a user scroll-up via real wheel input (not programmatic scrollTop),
 *  so the input-gated pin logic registers it as a user action and un-pins.
 *  Moves the mouse over the scroller first so the wheel event targets it.
 *  Uses repeated small wheel deltas (Chrome caps scroll distance per event). */
export async function wheelUp(page: Page, delta = 500): Promise<void> {
  const scroller = page.locator(".scroller");
  // Move the mouse to the center of the scroller so the wheel event targets it.
  const box = await scroller.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  }
  // Chrome caps scroll distance per wheel event (~100px). Use repeated events
  // to accumulate the requested delta.
  const steps = Math.max(1, Math.ceil(delta / 100));
  const stepDelta = -Math.ceil(delta / steps);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, stepDelta);
    await page.waitForTimeout(10);
  }
}

/** Scroll the transcript to the top via keyboard (Home key) after focusing the
 *  scroller. This sets `userScrolling` via the onkeydown handler, so the input-gated
 *  pin un-pins. More reliable than wheel on small viewports where content may be short. */
export async function scrollUpViaKeyboard(page: Page): Promise<void> {
  const scroller = page.locator(".scroller");
  // Focus the scroller (tabindex="0") without clicking — click may hit a child element.
  await scroller.focus();
  await page.keyboard.press("Home");
  await page.waitForTimeout(100);
}

/** Scroll the transcript to approximately `targetTop` using a hybrid approach:
 *  1. Focus the scroller and press Home — sets `userScrolling` via onScrollerKey, un-pins.
 *  2. Immediately set scrollTop programmatically to the target — `pinned` is now false,
 *     so the ResizeObserver won't yank back. The onScroll from this sees `userScrolling`
 *     still true (300ms window) but `top >= prevTop` (scrolling down from 0), so it
 *     holds `prevPinned = false`. */
export async function keyboardScrollToPosition(
  page: Page,
  targetTop: number,
): Promise<void> {
  const scroller = page.locator(".scroller");
  await scroller.focus();
  // Home sets userScrolling=true (onScrollerKey) and scrolls to the top → un-pins.
  await page.keyboard.press("Home");
  // Wait for the Home key's scroll event to fire and un-pin before setting position.
  // Poll for gap > 80 (un-pinned) rather than a fixed timeout — more robust on CI.
  await expect
    .poll(() =>
      scroller.evaluate((el) => {
        const s = el as HTMLElement;
        return s.scrollHeight - s.scrollTop - s.clientHeight;
      }),
    )
    .toBeGreaterThan(80);
  // Now set the exact position programmatically. pinned is false, so no yank-back.
  await scroller.evaluate((el, t) => {
    (el as HTMLElement).scrollTop = t;
  }, targetTop);
  await page.waitForTimeout(100);
}
