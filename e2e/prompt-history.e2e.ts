import { expect, type Page, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

const composer = (page: Page) => page.locator(".composer-wrap textarea");

// The focused greeting session at boot has exactly one user message — recall surfaces it.
const GREETING = "Add a /health route to the server and a smoke test for it.";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("ArrowUp in an empty composer recalls the previous prompt", async ({
  page,
}) => {
  const ta = composer(page);
  await expect(ta).toHaveValue("");
  await ta.focus();
  await page.keyboard.press("ArrowUp");
  await expect(ta).toHaveValue(GREETING);

  // ArrowDown walks back past the newest entry to the (empty) live draft.
  await page.keyboard.press("ArrowDown");
  await expect(ta).toHaveValue("");
});

test("ArrowUp swaps a work-in-progress draft; ArrowDown restores it exactly", async ({
  page,
}) => {
  const ta = composer(page);
  await ta.fill("a half-typed thought");
  // Caret sits at the end (single line = first AND last line), so ArrowUp recalls…
  await page.keyboard.press("ArrowUp");
  await expect(ta).toHaveValue(GREETING);
  // …and ArrowDown brings back the exact work-in-progress text.
  await page.keyboard.press("ArrowDown");
  await expect(ta).toHaveValue("a half-typed thought");
});

test("a just-sent prompt is recallable from the now-empty composer", async ({
  page,
}) => {
  const ta = composer(page);
  await ta.fill("send me then recall me");
  await page.keyboard.press("Enter");
  // The composer clears after sending.
  await expect(ta).toHaveValue("");

  // The just-sent prompt is the newest history entry.
  await page.keyboard.press("ArrowUp");
  await expect(ta).toHaveValue("send me then recall me");
  // The one before it is the seeded greeting prompt.
  await page.keyboard.press("ArrowUp");
  await expect(ta).toHaveValue(GREETING);
});

test("recall survives a reload (persisted submit log)", async ({ page }) => {
  const ta = composer(page);
  await ta.fill("durable across reload");
  await page.keyboard.press("Enter");
  await expect(ta).toHaveValue("");

  await page.reload();
  // The submit log is keyed by session id, which the reloaded store only knows
  // once the seed lands — wait for the transcript to be back (the just-sent
  // prompt row) before recalling, like a user who can see the page would.
  await expect(page.getByText("durable across reload").first()).toBeVisible();
  const reloaded = composer(page);
  await reloaded.focus();
  await page.keyboard.press("ArrowUp");
  await expect(reloaded).toHaveValue("durable across reload");
});

test("ArrowUp moves the caret within a multi-line draft before recalling", async ({
  page,
}) => {
  const ta = composer(page);
  // A real newline (Shift+Enter inserts one without sending).
  await ta.focus();
  await page.keyboard.type("line one");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("line two");
  // Caret is on the last line — ArrowUp should move it up a line, NOT recall history.
  await page.keyboard.press("ArrowUp");
  await expect(ta).toHaveValue("line one\nline two");
  // Now on the first line — a second ArrowUp recalls.
  await page.keyboard.press("ArrowUp");
  await expect(ta).toHaveValue(GREETING);
});

test("ArrowUp walks visual rows of a soft-wrapped line before recalling", async ({
  page,
}) => {
  const ta = composer(page);
  // One logical line (no newlines) long enough to soft-wrap into several visual rows.
  const wrapped = "wrap ".repeat(60).trim();
  await ta.focus();
  await ta.fill(wrapped);
  // Caret at the end sits on the LAST visual row. Under logical-line gating this string is
  // first-AND-last line, so ArrowUp would recall immediately (the jank). Visual gating
  // moves the caret up a row instead — the draft must stay put.
  await page.keyboard.press("ArrowUp");
  await expect(ta).toHaveValue(wrapped);
  // Jump to the very start (first visual row); now ArrowUp recalls.
  await ta.evaluate((el: HTMLTextAreaElement) => {
    el.selectionStart = el.selectionEnd = 0;
  });
  await page.keyboard.press("ArrowUp");
  await expect(ta).toHaveValue(GREETING);
});

test("history navigation does not hijack the slash-command menu arrows", async ({
  page,
}) => {
  const ta = composer(page);
  await ta.fill("/");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  // The slash menu owns ArrowUp/ArrowDown while open — the draft text stays "/".
  await page.keyboard.press("ArrowUp");
  await expect(ta).toHaveValue("/");
});

test("Alt+Enter inserts a newline instead of sending", async ({ page }) => {
  const ta = composer(page);
  await ta.focus();
  await page.keyboard.type("line one");
  // Alt+Enter should insert a newline, not send (matching Shift+Enter behavior).
  await page.keyboard.press("Alt+Enter");
  await page.keyboard.type("line two");
  await expect(ta).toHaveValue("line one\nline two");
});
