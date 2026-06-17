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

  await page.getByTestId("theme-dark").click();
  await expect(html).toHaveAttribute("data-theme", "dark");

  await page.getByTestId("theme-light").click();
  await expect(html).toHaveAttribute("data-theme", "light");

  // Back to dark, then reload: the inline pre-paint script must restore it.
  await page.getByTestId("theme-dark").click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "dark");

  // "System" clears the override and re-resolves to the emulated light scheme.
  await page.getByTestId("settings-toggle").click();
  await page.getByTestId("theme-system").click();
  await expect(html).toHaveAttribute("data-theme", "light");
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
