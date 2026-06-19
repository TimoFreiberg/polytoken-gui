import { expect, type Page } from "@playwright/test";

/** Reset the mock to the initial fixture, load the app in dev mode, and wait for
 *  the greeting conversation to finish replaying so assertions start from a known
 *  state. */
export async function gotoFresh(page: Page): Promise<void> {
  await page.request.get("/debug/reset");
  await page.goto("/?dev");
  // greeting's final assistant line — present only once replay completes
  await expect(
    page.getByText("Routes live in", { exact: false }),
  ).toBeVisible();
}

/** Click one of the dev-bar buttons that drives the mock to a named UI state. */
export async function drive(page: Page, script: string): Promise<void> {
  await page.getByRole("button", { name: script, exact: true }).click();
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

/** Ensure the session sidebar is open. Desktop opens by default; the phone drawer
 *  needs the toggle. Driven off `data-open` (the drawer stays mounted off-screen, so
 *  visibility checks are unreliable). */
export async function openSidebar(page: Page): Promise<void> {
  const sidebar = page.getByTestId("sidebar");
  if ((await sidebar.getAttribute("data-open")) !== "true")
    await page.getByTestId("sidebar-toggle").click();
  await expect(sidebar).toHaveAttribute("data-open", "true");
}
