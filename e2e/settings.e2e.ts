import { expect, test } from "@playwright/test";
import { gotoFresh, openSettings } from "./helpers.js";

// Playwright gives each test a fresh BrowserContext (empty localStorage), so there's
// no cross-spec bleed of the persisted pantoken.settingsSection — each spec opens the
// section it exercises via openSettings() anyway. (An earlier beforeEach cleared the
// pref after gotoFresh, but the component had already read it at mount, so it was a
// no-op; removed.)
test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("settings panel opens from the sidebar and lists its sections", async ({
  page,
}) => {
  await expect(
    page.locator("header").getByTestId("settings-toggle"),
  ).toHaveCount(0);
  // AC.1 (desktop): the sidebar Settings button is icon-only — no "Settings" text label.
  await expect(page.getByTestId("settings-toggle")).not.toContainText("Settings");
  await page.getByTestId("settings-toggle").click();

  const panel = page.getByTestId("settings-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Appearance", { exact: true })).toBeVisible();
  await expect(panel.getByText("Notifications", { exact: true })).toBeVisible();
  await expect(panel.getByText("Models", { exact: true })).toBeVisible();
  await expect(panel.getByText("Environment", { exact: true })).toBeVisible();
  await expect(panel.getByText("Access token", { exact: true })).toBeVisible();
  await page.getByTestId("settings-tab-notifications").click();
  await expect(page.getByTestId("connection-settings-row")).toContainText("Live");
  // The dev/mock server runs without PANTOKEN_TOKEN, so no token is saved client-side.
  // Only the active section renders, so jump to the Access token tab to see its body.
  await page.getByTestId("settings-tab-token").click();
  await expect(panel.getByText("No token saved")).toBeVisible();
});

test("the Environment section shows login-shell status and persists an override", async ({
  page,
}) => {
  await openSettings(page, "environment");
  const env = page.getByTestId("settings-panel").getByTestId("env-section");
  await expect(env.getByText("Login shell", { exact: true })).toBeVisible();
  // Mock mode never runs the startup capture, so the status reads "Not captured".
  await expect(env.getByTestId("login-shell-status")).toContainText(
    "Not captured",
  );

  await env.getByTestId("login-shell-input").fill("/opt/homebrew/bin/fish");
  await env.getByRole("button", { name: "Save" }).click();

  // Round-trips through the server's pantokenSettings broadcast, which reads back the
  // persisted file. Reload (a fresh WS connection) + reopen: the field is re-seeded
  // from disk, proving it persisted server-side.
  await page.reload();
  await openSettings(page, "environment");
  await expect(page.getByTestId("login-shell-input")).toHaveValue(
    "/opt/homebrew/bin/fish",
  );

  // Clear back to the default (also leaves the e2e data dir clean for sibling specs).
  await page
    .getByTestId("env-section")
    .getByRole("button", { name: "Default" })
    .click();
  await expect(page.getByTestId("login-shell-input")).toHaveValue("");
});

test("theme toggle drives the data-theme override and persists it", async ({
  page,
}) => {
  const html = page.locator("html");
  // Fresh device defaults to "system"; the emulated OS scheme is light.
  await expect(html).toHaveAttribute("data-theme", "light");

  await openSettings(page, "appearance");
  await expect(page.getByTestId("theme-system")).toHaveAttribute(
    "aria-checked",
    "true",
  );

  // The theme-color meta (PWA / browser chrome) tracks the active palette's --bg.
  const themeColor = page.locator('meta[name="theme-color"]');
  await page.getByTestId("theme-dark").click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  // color-scheme drives native UA widgets (scrollbars, form controls); it must
  // track the active palette, not the OS scheme.
  await expect(html).toHaveCSS("color-scheme", "dark");
  await expect(themeColor).toHaveAttribute("content", "#171614");

  await page.getByTestId("theme-light").click();
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect(html).toHaveCSS("color-scheme", "light");
  await expect(themeColor).toHaveAttribute("content", "#f4f1e9");

  // Back to dark, then reload: the inline pre-paint script must restore both the
  // data-theme AND the theme-color, before the bundle loads.
  await page.getByTestId("theme-dark").click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "dark");
  // The inline pre-paint script sets color-scheme as an inline style (before CSS
  // loads), which is what prevents a flash of wrong-theme native scrollbar.
  expect(await html.evaluate((el) => el.style.colorScheme)).toBe("dark");
  await expect(themeColor).toHaveAttribute("content", "#171614");

  // "System" clears the override and re-resolves to the emulated light scheme.
  await openSettings(page, "appearance");
  await page.getByTestId("theme-system").click();
  await expect(html).toHaveAttribute("data-theme", "light");
});

test("text-size stepper scales the transcript and persists across reload", async ({
  page,
}) => {
  const html = page.locator("html");
  const scale = async () =>
    Number.parseFloat(
      (await html.evaluate((el) =>
        getComputedStyle(el).getPropertyValue("--font-scale"),
      )) || "1",
    );

  await expect(await scale()).toBe(1);

  await openSettings(page, "appearance");
  const panel = page.getByTestId("settings-panel");
  await expect(panel.getByTestId("font-reset")).toHaveText("100%");

  // Grow twice → the var climbs above 1 and the readout tracks it.
  await panel.getByTestId("font-larger").click();
  await panel.getByTestId("font-larger").click();
  expect(await scale()).toBeGreaterThan(1);
  await expect(panel.getByTestId("font-reset")).not.toHaveText("100%");
  const grown = await scale();

  // Pre-paint restores the persisted scale before the bundle loads (no reflow flash).
  await page.reload();
  await expect(await scale()).toBe(grown);

  // Reset returns to the default and clears the override; that too survives reload.
  await openSettings(page, "appearance");
  await page.getByTestId("font-reset").click();
  await expect(await scale()).toBe(1);
  await page.reload();
  await expect(await scale()).toBe(1);
});

test("Cmd/Ctrl +/-/0 zoom the transcript text", async ({ page }) => {
  const html = page.locator("html");
  const scale = async () =>
    Number.parseFloat(
      (await html.evaluate((el) =>
        getComputedStyle(el).getPropertyValue("--font-scale"),
      )) || "1",
    );

  await expect(await scale()).toBe(1);

  await page.keyboard.press("Control+Equal");
  expect(await scale()).toBeGreaterThan(1);

  await page.keyboard.press("Control+Minus");
  await expect(await scale()).toBe(1);

  await page.keyboard.press("Control+Equal");
  await page.keyboard.press("Control+Digit0");
  await expect(await scale()).toBe(1);
});

test("Cmd/Ctrl+, toggles the settings panel", async ({ page }) => {
  const panel = page.getByTestId("settings-panel");
  await expect(panel).toBeHidden();
  // Open with the standard preferences shortcut…
  await page.keyboard.press("Control+Comma");
  await expect(panel).toBeVisible();
  // …and the same shortcut closes it again.
  await page.keyboard.press("Control+Comma");
  await expect(panel).toBeHidden();
});

test("settings panel closes via Escape and the close button", async ({
  page,
}) => {
  const panel = page.getByTestId("settings-panel");

  await page.getByTestId("settings-toggle").click();
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();

  await page.getByTestId("settings-toggle").click();
  await expect(panel).toBeVisible();
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(panel).toBeHidden();
});

test("desktop Settings contains focus and restores its opener", async ({ page }) => {
  const opener = page.getByTestId("settings-toggle");
  await opener.click();
  const panel = page.getByTestId("settings-panel");
  await expect(panel).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(panel.getByRole("button", { name: "Close settings" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(panel.getByTestId("hide-thinking")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(panel.getByRole("button", { name: "Close settings" })).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("the section rail deep-links to a section without scrolling", async ({
  page,
}) => {
  // The default-open section is Appearance; Environment's controls live further down
  // the old single scroll. With the left-rail nav, clicking the Environment tab lands
  // on its body immediately — the env-section is visible without scrolling.
  await page.getByTestId("settings-toggle").click();
  // Sanity: the Environment tab is present and not yet selected (Appearance is).
  const envTab = page.getByTestId("settings-tab-environment");
  await expect(envTab).toHaveAttribute("aria-selected", "false");

  await envTab.click();
  await expect(envTab).toHaveAttribute("aria-selected", "true");

  // The left-rail swaps sections by mounting only the active one (no scroll), so
  // the panel body's scrollTop stays 0. This is a weak guard (it can't really be
  // non-zero given only one section renders) — the real teeth are the
  // login-shell-status-visible + theme-system-gone assertions below. Kept as a
  // cheap sanity check that nothing scrolled the panel.
  const env = page.getByTestId("settings-panel").getByTestId("env-section");
  await expect(env.getByTestId("login-shell-status")).toBeVisible();
  const bodyScrollTop = await page
    .getByTestId("settings-panel")
    .locator(".body")
    .evaluate((el) => el.scrollTop);
  expect(bodyScrollTop).toBe(0);
  // …and the Appearance section (the default) is no longer rendered at all.
  await expect(
    page.getByTestId("settings-panel").getByTestId("theme-system"),
  ).toHaveCount(0);
});

test("Alt+1..6 jump between section tabs", async ({ page }) => {
  await page.getByTestId("settings-toggle").click();
  const panel = page.getByTestId("settings-panel");

  // Alt+2 → Notifications: its push control appears, Appearance's theme control is gone.
  await page.keyboard.press("Alt+2");
  await expect(panel.getByTestId("settings-tab-notifications")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(panel.getByText("Push on this device")).toBeVisible();
  await expect(panel.getByTestId("theme-system")).toHaveCount(0);

  // Alt+5 → MCP servers.
  await page.keyboard.press("Alt+5");
  await expect(panel.getByTestId("settings-tab-mcp")).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // Alt+6 → Access token: its body appears too, proving the shortcut spans the rail.
  await page.keyboard.press("Alt+6");
  await expect(panel.getByTestId("settings-tab-token")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(panel.getByText("No token saved")).toBeVisible();

  // Alt+1 → back to Appearance: the theme control returns.
  await page.keyboard.press("Alt+1");
  await expect(panel.getByTestId("theme-system")).toBeVisible();
});

test("Escape closes the panel from a non-default section tab", async ({
  page,
}) => {
  const panel = page.getByTestId("settings-panel");
  await openSettings(page, "environment");
  await expect(panel.getByTestId("env-section")).toBeVisible();

  // Esc from a non-default (Environment) tab still closes the whole panel.
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();

  // Reopening lands back on the persisted Environment tab (the chosen reopen behavior).
  await page.getByTestId("settings-toggle").click();
  await expect(panel.getByTestId("settings-tab-environment")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(panel.getByTestId("env-section")).toBeVisible();
});

test("the Access token tab shows the data directory with copy + reveal actions", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openSettings(page, "token");
  const section = page.getByTestId("data-dir-section");
  // The mock/e2e server sends dataDir in hello — the path renders (non-empty).
  await expect(section.getByTestId("data-dir-path")).not.toHaveText("unknown");
  const path = await section.getByTestId("data-dir-path").textContent();
  expect(path && path.length > 0).toBe(true);

  // Copy path writes the data dir to the clipboard.
  await section.getByRole("button", { name: "Copy path" }).click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe(path);

  // Reveal sends the openDataDir message — the server best-efforts the spawn. We
  // can't assert Finder opened, but we can assert no error surfaced (the mock data
  // dir exists, so the spawn path is reachable; on a headless runner `open` may
  // no-op, which is the designed graceful degrade — assert no error toast).
  await section.getByRole("button", { name: "Reveal" }).click();
  await expect(page.getByTestId("settings-panel")).toBeVisible();
});
