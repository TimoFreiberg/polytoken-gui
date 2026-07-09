import { expect, test, type Page } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

// @-reference autocomplete: files (the original @-file mention), plus the kind-aware
// picker added on top — skills (`@skill:`/`@s:`), subagents (`@subagent:`/`@a:`),
// models (`@model:`/`@m:`), and the sigil rows that narrow a bare/partial query into
// one of those kinds. Prompts stay plain text; the picker only ever inserts a
// canonical `@…` token into the textarea.

const ta = (page: Page) => page.locator(".composer-wrap textarea");
const menu = (page: Page) => page.getByTestId("at-menu");
const row = (page: Page, ref: string) =>
  menu(page).locator(`[data-ref="${ref}"]`);

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("a draft's @-mention searches the draft cwd via the server; a real session doesn't", async ({
  page,
}) => {
  const box = ta(page);

  // A real (focused) session never fires the server fallback — its small index isn't
  // truncated — so the cwd-only marker is absent.
  await box.click();
  await page.keyboard.type("@DRAFT-CWD");
  await expect(menu(page)).toHaveCount(0);
  await box.fill("");

  // A new-session draft searches via the server fallback scoped to its target cwd, so the
  // cwd-derived marker appears — and ordinary fixture files still resolve too.
  await page.getByRole("button", { name: "New session…" }).click();
  await box.click();
  await page.keyboard.type("@DRAFT-CWD");
  await expect(menu(page)).toBeVisible();
  await expect(
    menu(page).getByText("DRAFT-CWD.md", { exact: false }),
  ).toBeVisible();

  await box.fill("");
  await box.click();
  await page.keyboard.type("@Composer");
  await expect(
    menu(page).getByText("client/src/components/Composer.svelte"),
  ).toBeVisible();
});

test("@skill: lists the available skills; Enter inserts the canonical form", async ({
  page,
}) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@skill:");
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "skill:debug")).toBeVisible();
  await expect(row(page, "skill:journal")).toBeVisible();
  await box.press("Enter");
  await expect(box).toHaveValue("@skill:debug");
});

test("@s:jou narrows the shorthand to journal only", async ({ page }) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@s:jou");
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "skill:journal")).toBeVisible();
  await expect(row(page, "skill:debug")).toHaveCount(0);
  await box.press("Enter");
  // Canonical form is always the long sigil, regardless of the shorthand typed.
  await expect(box).toHaveValue("@skill:journal");
});

test("@a: lists the available subagents", async ({ page }) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@a:");
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "subagent:reviewer")).toBeVisible();
  await expect(row(page, "subagent:explorer")).toBeVisible();
  await row(page, "subagent:reviewer").click();
  await expect(box).toHaveValue("@subagent:reviewer");
});

test("@m: lists the mock models; accepting inserts the canonical provider/modelId", async ({
  page,
}) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@m:");
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "model:anthropic/claude-opus-4-8")).toBeVisible();
  await expect(row(page, "model:anthropic/claude-sonnet-4-6")).toBeVisible();
  await expect(row(page, "model:openai/gpt-5")).toBeVisible();

  // Narrow with the shorthand's partial, then accept — canonical `@model:provider/id`
  // regardless of the `m:` shorthand used to get there.
  await page.keyboard.type("gpt");
  await expect(row(page, "model:openai/gpt-5")).toBeVisible();
  await expect(row(page, "model:anthropic/claude-opus-4-8")).toHaveCount(0);
  await box.press("Enter");
  await expect(box).toHaveValue("@model:openai/gpt-5");
});

test("@sk shows the skill: sigil row after file matches; accepting it narrows into the skill list", async ({
  page,
}) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@sk");
  await expect(menu(page)).toBeVisible();
  // "docs/ADR-desktop-shell.md" contains "sk" (deSKtop) — a genuine file match — and
  // the skill: sigil is offered right after it (sigils always sort last).
  await expect(row(page, "file:docs/ADR-desktop-shell.md")).toBeVisible();
  const sigil = row(page, "sigil:skill:");
  await expect(sigil).toBeVisible();

  // Enter accepts the highlighted row; arrow down to the sigil (it's the last row).
  const count = await menu(page).locator("[data-ref]").count();
  for (let i = 0; i < count - 1; i++) await box.press("ArrowDown");
  await box.press("Enter");
  await expect(box).toHaveValue("@skill:");
  // The menu recomputed to the skill kind's full list — same keep-narrowing mechanic
  // as a directory "/".
  await expect(row(page, "skill:debug")).toBeVisible();
  await expect(row(page, "skill:journal")).toBeVisible();
});

test("Escape dismisses the @-reference menu without changing the draft", async ({
  page,
}) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@skill:");
  await expect(menu(page)).toBeVisible();
  await box.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await expect(box).toHaveValue("@skill:");
});
