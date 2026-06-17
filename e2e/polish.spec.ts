import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("edit-tool card: collapsed +N/−M badge, expands to a @pierre/diffs render", async ({
  page,
}) => {
  await drive(page, "editdiff");
  const card = page.locator(".tool", { hasText: "Edit file" });
  await expect(card).toBeVisible();
  // Collapsed badge shows added/removed line counts (the edit changes one line).
  const counts = card.locator(".counts");
  await expect(counts).toContainText("+1");
  await expect(counts).toContainText("1");

  // The collapse/expand toggle carries a descriptive tooltip (title audit).
  await expect(card.locator(".head")).toHaveAttribute(
    "title",
    "Expand tool details",
  );

  // Expanding mounts the pierre diff into a shadow root (self-contained HTML).
  await card.locator(".head").click();
  await expect
    .poll(
      async () =>
        card.evaluate((el) =>
          [...el.querySelectorAll("*")].some((n) => !!n.shadowRoot),
        ),
      { timeout: 8000 },
    )
    .toBe(true);
});

test("message timestamps render with an exact-time tooltip", async ({
  page,
}) => {
  // The greeting already has user + assistant messages with timestamps.
  const times = page.locator("time.ts");
  await expect(times.first()).toBeVisible();
  await expect(times.first()).toHaveAttribute("title", /.+/);
  await expect(times.first()).toHaveAttribute("datetime", /.+/);
});

test("copy button copies an agent message and shows feedback", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const assistant = page.locator(".row.assistant").first();
  await assistant.hover();
  const copy = assistant.getByRole("button", { name: "Copy message" });
  await expect(copy).toBeVisible();
  await copy.click();
  await expect(assistant.getByText("Copied", { exact: false })).toBeVisible();
});

test("no stray caret after a turn ends via sessionUpdated (not runCompleted)", async ({
  page,
}) => {
  // gotoFresh returns as soon as "Routes live in" appears — which is mid-stream.
  // Wait for the greeting's FINAL delta so its deltas can't interleave with the
  // turn we're about to drive (the greeting never goes "running", so there's no
  // working-indicator to wait on).
  await expect(
    page.getByText("add a Bun test", { exact: false }),
  ).toBeVisible();
  await drive(page, "idle");
  // Wait for the streamed line to finish.
  await expect(
    page.getByText("ends with a status update", { exact: false }),
  ).toBeVisible();
  // The session is idle again — the streaming caret must be gone.
  await expect
    .poll(() => page.locator(".row.assistant .caret").count())
    .toBe(0);
});

test("tab title mirrors the active session title", async ({ page }) => {
  // The greeting snapshot titles the session "Wire up the WebSocket bridge";
  // document.title should reflect it (suffixed with the app name) rather than
  // staying the static "pilot".
  await expect(page).toHaveTitle("Wire up the WebSocket bridge · pilot");
});

test("composer: live markdown preview toggle", async ({ page }) => {
  const ta = page.locator(".composer-wrap textarea");
  await ta.fill("some **bold** and `code`");
  await page
    .locator(".composer-wrap")
    .getByRole("button", { name: "Preview", exact: true })
    .click();
  const preview = page.locator(".composer-wrap .prose.preview");
  await expect(preview.locator("strong")).toHaveText("bold");
  await expect(preview.locator("code")).toHaveText("code");
  // Toggle back restores the editable textarea with the draft intact.
  await page
    .locator(".composer-wrap")
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await expect(ta).toHaveValue("some **bold** and `code`");
});

test("type-to-focus: a printable key focuses the composer", async ({
  page,
}) => {
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur(),
  );
  await page.keyboard.press("h");
  await expect(page.locator(".composer-wrap textarea")).toBeFocused();
});

test("binary select renders a Yes/No card with the affirmative as primary", async ({
  page,
}) => {
  await drive(page, "yesno");
  const actions = page.locator('[role="dialog"] .actions.two button');
  await expect(actions).toHaveCount(2);
  // Affirmative ("Allow") is promoted to the primary button on the right,
  // even though it is second in the options array.
  await expect(actions.nth(0)).toHaveText("Don't allow");
  await expect(actions.nth(1)).toHaveText("Allow");
  await expect(actions.nth(1)).toHaveClass(/primary/);
});

test("timeout-bearing dialog shows a countdown and auto-resolves deny-safe", async ({
  page,
}) => {
  await drive(page, "timeout");
  await expect(page.getByText(/Auto-dismiss in \d+s/)).toBeVisible();
  // After the 3s timeout it auto-resolves to the deny-safe default.
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 8000 });
  await expect(page.getByText("Denied — skipping that step.")).toBeVisible();
});

test("Ctrl/Cmd+Up jumps to the most recent user prompt", async ({ page }) => {
  // Wait for the greeting to finish, then add several turns so the transcript is
  // tall enough to scroll (otherwise everything fits and nothing leaves the view).
  await expect(
    page.getByText("add a Bun test", { exact: false }),
  ).toBeVisible();
  for (let i = 0; i < 3; i++) {
    await drive(page, "reply");
    await expect(
      page.getByText("That confirms it", { exact: false }).last(),
    ).toBeVisible();
  }
  const lastPrompt = page
    .getByText("Show me the streamed reply script.")
    .last();
  // Scroll to the top so the last prompt is out of view…
  await page
    .locator(".scroller")
    .evaluate((el) => ((el as HTMLElement).scrollTop = 0));
  await expect(lastPrompt).not.toBeInViewport();
  // …then the hotkey brings it back into view.
  await page.keyboard.press("Control+ArrowUp");
  await expect(lastPrompt).toBeInViewport();
});

test("PWA update prompt appears and can be dismissed", async ({ page }) => {
  // The ?dev bar's "update" button stands in for a real service-worker update.
  await page.getByRole("button", { name: "update", exact: true }).click();
  const toast = page.getByText("A new version of pilot is available");
  await expect(toast).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Dismiss update" }).click();
  await expect(toast).toBeHidden();
});
