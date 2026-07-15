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

/** Open the settings panel and (optionally) jump to a section via its left-rail tab.
 *  With the section-nav refactor only the active section renders, so a test that
 *  touches a section's controls must navigate to that tab first — this does both in
 *  one call. Omit `section` to open on whatever section was last active (persisted
 *  in localStorage); pass a SectionId to land on a specific one. */
export async function openSettings(
  page: Page,
  section?: "appearance" | "notifications" | "models" | "environment" | "token",
): Promise<void> {
  const settings = page.getByTestId("settings-toggle");
  if (
    (await page.getByTestId("sidebar").getAttribute("data-open")) !== "true"
  )
    await openSidebar(page);
  await settings.click();
  if (section) await page.getByTestId(`settings-tab-${section}`).click();
}

/** Ensure the session sidebar is open. Desktop opens by default; the phone drawer
 *  needs the header's leading-edge chevron (the header hamburger was removed — this is now
 *  the only click affordance, besides ⌘B). Driven off `data-open` (the drawer stays
 *  mounted off-screen, so visibility checks are unreliable). */
export async function openSidebar(page: Page): Promise<void> {
  const sidebar = page.getByTestId("sidebar");
  if ((await sidebar.getAttribute("data-open")) !== "true")
    await page.getByTestId("sidebar-open").click();
  await expect(sidebar).toHaveAttribute("data-open", "true");
}

/** Ensure the right context panel (flagged files, background jobs, todos) is open.
 *  Uses the visible desktop/badged-header entry when available; an empty phone header
 *  stays quiet, so that path opens Context through the labeled Sessions destination. */
export async function openRightSidebar(page: Page): Promise<void> {
  const panel = page.getByTestId("right-sidebar");
  if ((await panel.getAttribute("data-open")) !== "true") {
    const headerEntry = page.getByTestId("context-open");
    if (await headerEntry.isVisible()) {
      await headerEntry.click();
    } else {
      await openSidebar(page);
      await page.getByTestId("sidebar-context").click();
    }
  }
  await expect(panel).toHaveAttribute("data-open", "true");
}
