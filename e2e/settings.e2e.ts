import { expect, test } from "@playwright/test";
import { gotoFresh, openSettings } from "./helpers.js";

// Playwright gives each test a fresh BrowserContext (empty localStorage), so there's
// no cross-spec bleed of the persisted pilot.settingsSection — each spec opens the
// section it exercises via openSettings() anyway. (An earlier beforeEach cleared the
// pref after gotoFresh, but the component had already read it at mount, so it was a
// no-op; removed.)
test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("settings panel opens from the header gear and lists its sections", async ({
  page,
}) => {
  await page.getByTestId("settings-toggle").click();

  const panel = page.getByTestId("settings-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Appearance", { exact: true })).toBeVisible();
  await expect(panel.getByText("Notifications", { exact: true })).toBeVisible();
  await expect(panel.getByText("Providers", { exact: true })).toBeVisible();
  await expect(panel.getByText("Models", { exact: true })).toBeVisible();
  await expect(panel.getByText("Environment", { exact: true })).toBeVisible();
  await expect(panel.getByText("Access token", { exact: true })).toBeVisible();
  // The dev/mock server runs without PILOT_TOKEN, so no token is saved client-side.
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

  // Round-trips through the server's pilotSettings broadcast, which reads back the
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

test("saving a provider API key flips it to connected", async ({ page }) => {
  await openSettings(page, "providers");
  // The Providers list starts collapsed — expand it to reach the rows.
  await page.getByTestId("providers-toggle").click();

  // Google ships unconnected + key-capable in the mock.
  const google = page.getByTestId("provider-google");
  await expect(google.getByText("Not connected")).toBeVisible();

  await google.getByRole("button", { name: "Set key" }).click();
  await page.getByTestId("provider-key-input").fill("sk-test-key");
  // Scope to the key form — the access-token form also has a "Save" button.
  await page.locator(".keyform").getByRole("button", { name: "Save" }).click();

  // The server-side flip round-trips back as a refreshed provider list.
  await expect(google.getByText("Connected · API key")).toBeVisible();
  await expect(google.getByRole("button", { name: "Remove" })).toBeVisible();
});

test("OAuth sign-in flow connects a provider", async ({ page }) => {
  await openSettings(page, "providers");
  await page.getByTestId("providers-toggle").click();

  // OpenAI Codex ships OAuth-capable but unconnected in the mock.
  const codex = page.getByTestId("provider-openai-codex");
  await expect(codex.getByText("Not connected")).toBeVisible();
  await codex.getByTestId("provider-signin").click();

  // The interactive dialog surfaces the authorize link + a paste field — the remote
  // flow: open on the phone, paste the code back (no Tailscale callback needed).
  const dialog = page.getByTestId("oauth-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("oauth-open")).toBeVisible();
  await dialog.getByTestId("oauth-input").fill("mock-auth-code");
  await dialog.getByRole("button", { name: "Submit" }).click();

  // The login completes; closing the success state reveals the flipped row.
  await expect(dialog.getByTestId("oauth-done")).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(codex.getByText("Connected · OAuth")).toBeVisible();
  await expect(codex.getByTestId("provider-signout")).toBeVisible();
});

test("cancelling the OAuth dialog leaves the provider unconnected", async ({
  page,
}) => {
  await openSettings(page, "providers");
  await page.getByTestId("providers-toggle").click();
  const codex = page.getByTestId("provider-openai-codex");
  await codex.getByTestId("provider-signin").click();

  const dialog = page.getByTestId("oauth-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await expect(dialog).toBeHidden();
  await expect(codex.getByText("Not connected")).toBeVisible();
  await expect(codex.getByTestId("provider-signin")).toBeVisible();
});

test("OAuth sign-out disconnects a provider", async ({ page }) => {
  await openSettings(page, "providers");
  await page.getByTestId("providers-toggle").click();

  // Anthropic ships OAuth-connected in the mock.
  const anthropic = page.getByTestId("provider-anthropic");
  await expect(anthropic.getByText("Connected · OAuth")).toBeVisible();
  await anthropic.getByTestId("provider-signout").click();

  // Round-trips back as a refreshed provider list: now disconnected + signable-in.
  await expect(anthropic.getByText("Not connected")).toBeVisible();
  await expect(anthropic.getByTestId("provider-signin")).toBeVisible();
});

test("setting a default model persists in the panel", async ({ page }) => {
  await openSettings(page, "models");
  const trigger = page.getByTestId("default-model");
  // Opens the custom picker (a native <select> can't host the search box), then picks GPT-5.
  await trigger.click();
  await page.getByTestId("default-model-option-openai-gpt-5").click();
  // Round-trips through the server's modelDefaults broadcast; the trigger shows the label.
  await expect(trigger).toHaveText(/GPT-5/);
});

test("the default-model picker filters to favorites and offers a search", async ({
  page,
}) => {
  // Favorite only GPT-5; the picker should then offer just that (plus the current default,
  // marked "not favorited" so it stays selectable).
  await openSettings(page, "models");
  await page.getByTestId("favorites-toggle").click();
  await page.getByTestId("fav-group-openai").click();
  await page.getByTestId("fav-openai-gpt-5").getByRole("checkbox").check();

  const trigger = page.getByTestId("default-model");
  await trigger.click();
  const menu = page.getByTestId("default-model-menu");
  // The favorite + the active default show; the other non-favorites are hidden.
  await expect(
    menu.getByTestId("default-model-option-openai-gpt-5"),
  ).toBeVisible();
  await expect(
    menu.getByTestId("default-model-option-anthropic-claude-opus-4-8"),
  ).toBeVisible();
  await expect(menu.getByText("not favorited")).toBeVisible();
  await expect(
    menu.getByTestId("default-model-option-anthropic-claude-sonnet-4-6"),
  ).toHaveCount(0);

  // The search box narrows the (here, favorites-filtered) list.
  await menu.getByPlaceholder("Search models…").fill("zzzz");
  await expect(menu.getByText("No models match")).toBeVisible();
});

test("favorites filter the header model picker, keeping the active model visible", async ({
  page,
}) => {
  // Favorite only DeepSeek; the active model stays anthropic/claude-opus-4-8.
  await openSettings(page, "models");
  // The Favorites list starts collapsed — open it, then expand deepseek to reach its box.
  await page.getByTestId("favorites-toggle").click();
  await page.getByTestId("fav-group-deepseek").click();
  await page
    .getByTestId("fav-deepseek-deepseek-v4-flash")
    .getByRole("checkbox")
    .check();
  await page.keyboard.press("Escape"); // close settings to reach the header picker

  await page
    .locator(".mp .badge")
    .filter({ hasText: "Claude Opus 4.8" })
    .click();
  const panel = page.locator(".mp .panel");
  // Favorited model + the active (non-favorite) model both show; the rest are hidden.
  await expect(panel.getByText("DeepSeek V4 Flash")).toBeVisible();
  await expect(panel.getByText("Claude Opus 4.8")).toBeVisible();
  await expect(panel.getByText("not favorited")).toBeVisible();
  await expect(panel.getByText("Claude Sonnet 4.6")).toHaveCount(0);
  await expect(panel.getByText("GPT-5")).toHaveCount(0);
});

test("the favorites list has a search that filters models", async ({
  page,
}) => {
  await openSettings(page, "models");
  const settings = page.getByTestId("settings-panel");
  // The Favorites list (with its search) starts collapsed — open it first.
  await page.getByTestId("favorites-toggle").click();
  const search = settings.getByPlaceholder("Search models…");

  await search.fill("gpt");
  await expect(settings.getByTestId("fav-openai-gpt-5")).toBeVisible();
  await expect(
    settings.getByTestId("fav-deepseek-deepseek-v4-flash"),
  ).toHaveCount(0);

  await search.fill("zzzz");
  await expect(settings.getByText("No models match")).toBeVisible();
});

test("the Providers list is collapsed by default and expands on click", async ({
  page,
}) => {
  await openSettings(page, "providers");
  const toggle = page.getByTestId("providers-toggle");
  // The header is present but the rows are hidden until expanded.
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("provider-google")).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("provider-google")).toBeVisible();
});

test("favorites groups collapse by default, expand on click, and a search auto-expands", async ({
  page,
}) => {
  const settings = page.getByTestId("settings-panel");
  await openSettings(page, "models");
  await page.getByTestId("favorites-toggle").click();

  // No favorites in the mock, so every provider group starts collapsed.
  const openai = page.getByTestId("fav-group-openai");
  await expect(openai).toHaveAttribute("aria-expanded", "false");
  await expect(settings.getByTestId("fav-openai-gpt-5")).toHaveCount(0);

  // Clicking the group header reveals its models.
  await openai.click();
  await expect(openai).toHaveAttribute("aria-expanded", "true");
  await expect(settings.getByTestId("fav-openai-gpt-5")).toBeVisible();
  await openai.click(); // collapse again
  await expect(settings.getByTestId("fav-openai-gpt-5")).toHaveCount(0);

  // A search auto-expands matching groups without a manual click.
  await settings.getByPlaceholder("Search models…").fill("gpt");
  await expect(settings.getByTestId("fav-openai-gpt-5")).toBeVisible();
});

test("a provider with a favorite is seeded open when the panel reopens", async ({
  page,
}) => {
  await openSettings(page, "models");
  // Open the Favorites list, then favorite a deepseek model (its group starts collapsed).
  await page.getByTestId("favorites-toggle").click();
  await page.getByTestId("fav-group-deepseek").click();
  await page
    .getByTestId("fav-deepseek-deepseek-v4-flash")
    .getByRole("checkbox")
    .check();

  // Close and reopen the panel; the seeding effect expands providers holding a favorite.
  await page.keyboard.press("Escape");
  await page.getByTestId("settings-toggle").click();
  await expect(page.getByTestId("fav-group-deepseek")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(
    page.getByTestId("fav-deepseek-deepseek-v4-flash"),
  ).toBeVisible();
  // A provider without a favorite stays collapsed.
  await expect(page.getByTestId("fav-group-openai")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

test("the Favorites list is collapsed by default and expands on click", async ({
  page,
}) => {
  await openSettings(page, "models");
  const toggle = page.getByTestId("favorites-toggle");
  // Header present (with a model count); the search + groups hide until expanded.
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toContainText("models");
  await expect(
    page.getByTestId("settings-panel").getByPlaceholder("Search models…"),
  ).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByTestId("settings-panel").getByPlaceholder("Search models…"),
  ).toBeVisible();
});

test("the Providers list has a search that filters the rows", async ({
  page,
}) => {
  await openSettings(page, "providers");
  await page.getByTestId("providers-toggle").click();
  const settings = page.getByTestId("settings-panel");

  const search = settings.getByPlaceholder("Search providers…");
  await search.fill("google");
  await expect(settings.getByTestId("provider-google")).toBeVisible();
  await expect(settings.getByTestId("provider-anthropic")).toHaveCount(0);

  await search.fill("zzzz");
  await expect(settings.getByText("No providers match")).toBeVisible();
});

test("Escape in a section search clears the filter before closing the panel", async ({
  page,
}) => {
  await openSettings(page, "providers");
  await page.getByTestId("providers-toggle").click();
  const panel = page.getByTestId("settings-panel");
  const search = panel.getByPlaceholder("Search providers…");

  await search.fill("google");
  await expect(panel.getByTestId("provider-anthropic")).toHaveCount(0);

  // First Escape clears the filter but leaves the panel open.
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("provider-anthropic")).toBeVisible();

  // A second Escape (empty box) closes the panel as usual.
  await search.press("Escape");
  await expect(panel).toBeHidden();
});

test("the Extensions list has a search that filters the rows", async ({
  page,
}) => {
  await openSettings(page, "extensions");
  await page.getByTestId("extensions-toggle").click();
  const settings = page.getByTestId("settings-panel");

  const search = settings.getByPlaceholder("Search extensions…");
  await search.fill("answer");
  await expect(settings.getByTestId("ext-answer.ts")).toBeVisible();
  await expect(settings.getByTestId("ext-tasklist.ts")).toHaveCount(0);

  await search.fill("zzzz");
  await expect(settings.getByText("No extensions match")).toBeVisible();
});

test("the Extensions section is collapsed by default and lists on expand", async ({
  page,
}) => {
  await openSettings(page, "extensions");
  const toggle = page.getByTestId("extensions-toggle");
  // Header present + summary count; rows hidden until expanded (and not yet queried).
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toContainText("4/5 on");
  await expect(page.getByTestId("ext-answer.ts")).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  // The mock's loaded extensions list, with counts; the errored one shows its problem.
  await expect(page.getByTestId("ext-answer.ts")).toBeVisible();
  await expect(page.getByTestId("ext-tasklist.ts")).toContainText("4 tools");
  await expect(page.getByTestId("ext-fancy-tui.ts")).toContainText(
    "terminal-only",
  );
  // The "applies next start" honesty note is present.
  await expect(
    page.getByText("takes effect on the session's", { exact: false }),
  ).toBeVisible();
});

test("toggling an extension flips its switch and reconciles with the server", async ({
  page,
}) => {
  await openSettings(page, "extensions");
  await page.getByTestId("extensions-toggle").click();

  // answer.ts ships enabled; noisy-notify.ts ships disabled (so re-enable is exercisable).
  const answer = page.getByTestId("ext-toggle-answer.ts");
  const noisy = page.getByTestId("ext-toggle-noisy-notify.ts");
  await expect(answer).toHaveAttribute("aria-checked", "true");
  await expect(noisy).toHaveAttribute("aria-checked", "false");

  // Disable answer.ts: optimistic flip, and the server's re-broadcast keeps it off.
  await answer.click();
  await expect(answer).toHaveAttribute("aria-checked", "false");

  // Re-enable the disabled one the same way.
  await noisy.click();
  await expect(noisy).toHaveAttribute("aria-checked", "true");

  // The flip survives a re-open (server is authoritative — the mock persisted both toggles).
  // The section stays expanded across close/reopen and re-queries on open, so the rows are
  // already shown without re-expanding.
  await page.keyboard.press("Escape");
  await page.getByTestId("settings-toggle").click();
  await expect(page.getByTestId("ext-toggle-answer.ts")).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(page.getByTestId("ext-toggle-noisy-notify.ts")).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("pilot-owned extensions group under a Pilot origin header with their description", async ({
  page,
}) => {
  await openSettings(page, "extensions");
  await page.getByTestId("extensions-toggle").click();

  // The Pilot origin header is present and expanded by default, grouping pilot's owned
  // extensions (session-namer for now) under it — the D3 "Pilot" badge projection.
  const pilotHeader = page.getByTestId("ext-origin-Pilot");
  await expect(pilotHeader).toBeVisible();
  await expect(pilotHeader).toHaveAttribute("aria-expanded", "true");
  await expect(pilotHeader).toContainText("Pilot");

  // session-namer appears under the Pilot group with its @pilot frontmatter description.
  const namer = page.getByTestId("ext-session-namer.ts");
  await expect(namer).toBeVisible();
  await expect(namer).toContainText(
    "Auto-names a session from its first prompt via the background model.",
  );
  await expect(page.getByTestId("ext-toggle-session-namer.ts")).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("the pilot-side toggle disables a pilot-owned extension (pi's force-exclude couldn't)", async ({
  page,
}) => {
  // Chunk 0 finding: pi's `-<resolvedPath>` force-exclude override is a NO-OP on
  // `additionalExtensionPaths` entries. So pilot owns its own enabled/disabled set
  // (`enabledExtensions`) and omits disabled owned paths from the array in warmUp. This
  // asserts that toggle actually persists for a pilot-owned row — the gap the force-exclude
  // path leaves for owned extensions.
  await openSettings(page, "extensions");
  await page.getByTestId("extensions-toggle").click();

  const toggle = page.getByTestId("ext-toggle-session-namer.ts");
  await expect(toggle).toHaveAttribute("aria-checked", "true");

  // Disable: optimistic flip, and the server re-broadcasts (pilotSettings + extensionList).
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");

  // The flip survives a re-open — the mock persisted it to pilot's enabledExtensions set
  // (the [OPEN E] toggle), proving the owned-row toggle is real where force-exclude wasn't.
  await page.keyboard.press("Escape");
  await page.getByTestId("settings-toggle").click();
  await expect(page.getByTestId("ext-toggle-session-namer.ts")).toHaveAttribute(
    "aria-checked",
    "false",
  );

  // Re-enable lands back on (the enabledExtensions round-trip both ways).
  await page.getByTestId("ext-toggle-session-namer.ts").click();
  await expect(page.getByTestId("ext-toggle-session-namer.ts")).toHaveAttribute(
    "aria-checked",
    "true",
  );
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
  await expect(themeColor).toHaveAttribute("content", "#242522");

  await page.getByTestId("theme-light").click();
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect(themeColor).toHaveAttribute("content", "#f7f6f2");

  // Back to dark, then reload: the inline pre-paint script must restore both the
  // data-theme AND the theme-color, before the bundle loads.
  await page.getByTestId("theme-dark").click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(themeColor).toHaveAttribute("content", "#242522");

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

test("Alt+1..7 jump between section tabs", async ({ page }) => {
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

  // Alt+7 → Access token: its body appears too, proving the shortcut spans the rail.
  await page.keyboard.press("Alt+7");
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

test("the background-model spec round-trips and warns loud on a bad spec", async ({
  page,
}) => {
  await openSettings(page, "models");
  const settings = page.getByTestId("settings-panel");

  // Starts unset (the e2e's reset wipes pilot-settings to defaults).
  await expect(settings.getByTestId("background-model-input")).toHaveValue("");

  // Set a spec that RESOLVES against the mock's model list (claude-sonnet-4-6 is in
  // MOCK_MODELS) and save.
  await settings.getByTestId("background-model-input").fill(
    "anthropic/claude-sonnet-4-6:low",
  );
  await settings.getByRole("button", { name: "Save" }).click();

  // No warning: the spec resolved cleanly.
  await expect(settings.getByTestId("background-model-warning")).toHaveCount(0);

  // Round-trips through the server's pilotSettings broadcast (which re-reads the
  // persisted file). Reload + reopen: the field is re-seeded from disk.
  await page.reload();
  await openSettings(page, "models");
  await expect(page.getByTestId("background-model-input")).toHaveValue(
    "anthropic/claude-sonnet-4-6:low",
  );

  // Now set a BAD spec: a model not in the mock's registry → the server resolves a
  // warning and the UI surfaces it loud (red `.warn` note), never silent.
  await page.getByTestId("background-model-input").fill("anthropic/nope-9-9");
  await page.getByRole("button", { name: "Save" }).click();
  const warning = page.getByTestId("background-model-warning");
  await expect(warning).toBeVisible();
  await expect(warning).toContainText(/No registered model matches/);

  // Clear back to unset (also leaves the e2e data dir clean for sibling specs).
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page.getByTestId("background-model-input")).toHaveValue("");
  await expect(page.getByTestId("background-model-warning")).toHaveCount(0);
});
