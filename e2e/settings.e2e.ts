import { expect, test } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

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
  await expect(panel.getByText("Access token", { exact: true })).toBeVisible();
  // The dev/mock server runs without PILOT_TOKEN, so no token is saved client-side.
  await expect(panel.getByText("No token saved")).toBeVisible();
});

test("saving a provider API key flips it to connected", async ({ page }) => {
  await page.getByTestId("settings-toggle").click();
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
  await page.getByTestId("settings-toggle").click();
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
  await page.getByTestId("settings-toggle").click();
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
  await page.getByTestId("settings-toggle").click();
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
  await page.getByTestId("settings-toggle").click();
  const select = page.getByTestId("default-model");
  await select.selectOption("openai:gpt-5");
  // Round-trips through the server's modelDefaults broadcast.
  await expect(select).toHaveValue("openai:gpt-5");
});

test("favorites filter the header model picker, keeping the active model visible", async ({
  page,
}) => {
  // Favorite only DeepSeek; the active model stays anthropic/claude-opus-4-8.
  await page.getByTestId("settings-toggle").click();
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
  await page.getByTestId("settings-toggle").click();
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
  await page.getByTestId("settings-toggle").click();
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
  await page.getByTestId("settings-toggle").click();
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
  await page.getByTestId("settings-toggle").click();
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
  await page.getByTestId("settings-toggle").click();
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
  await page.getByTestId("settings-toggle").click();
  await page.getByTestId("providers-toggle").click();
  const settings = page.getByTestId("settings-panel");

  const search = settings.getByPlaceholder("Search providers…");
  await search.fill("google");
  await expect(settings.getByTestId("provider-google")).toBeVisible();
  await expect(settings.getByTestId("provider-anthropic")).toHaveCount(0);

  await search.fill("zzzz");
  await expect(settings.getByText("No providers match")).toBeVisible();
});

test("the Extensions list has a search that filters the rows", async ({
  page,
}) => {
  await page.getByTestId("settings-toggle").click();
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
  await page.getByTestId("settings-toggle").click();
  const toggle = page.getByTestId("extensions-toggle");
  // Header present + summary count; rows hidden until expanded (and not yet queried).
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toContainText("4/5 on");
  await expect(page.getByTestId("ext-answer.ts")).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  // The mock's loaded extensions list, with counts; the errored one shows its problem.
  await expect(page.getByTestId("ext-answer.ts")).toBeVisible();
  await expect(page.getByTestId("ext-tasklist.ts")).toContainText("2 tools");
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
  await page.getByTestId("settings-toggle").click();
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

test("theme toggle drives the data-theme override and persists it", async ({
  page,
}) => {
  const html = page.locator("html");
  // Fresh device defaults to "system"; the emulated OS scheme is light.
  await expect(html).toHaveAttribute("data-theme", "light");

  await page.getByTestId("settings-toggle").click();
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
  await page.getByTestId("settings-toggle").click();
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

  await page.getByTestId("settings-toggle").click();
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
  await page.getByTestId("settings-toggle").click();
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
