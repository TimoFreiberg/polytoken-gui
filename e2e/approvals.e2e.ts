import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("confirm dialog: Allow resolves and surfaces a notice", async ({
  page,
}) => {
  await drive(page, "confirm");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Run destructive command?")).toBeVisible();
  await dialog.getByRole("button", { name: "Allow" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Approved — continuing.")).toBeVisible();
});

test("confirm dialog: Deny resolves with the deny notice", async ({ page }) => {
  await drive(page, "confirm");
  await page.getByRole("dialog").getByRole("button", { name: "Deny" }).click();
  await expect(page.getByText("Denied — skipping that step.")).toBeVisible();
});

test("project-trust card renders all five options + the cwd", async ({
  page,
}) => {
  await drive(page, "trust");
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("/Users/timo/src/untrusted-repo"),
  ).toBeVisible();
  for (const opt of [
    "Trust this folder",
    "Trust parent folder",
    "Trust for this session only",
    "Don't trust",
    "Don't trust (this session)",
  ]) {
    await expect(
      dialog.getByRole("button", { name: opt, exact: true }),
    ).toBeVisible();
  }
});

test("project-trust card: choosing an option dismisses it + confirms", async ({
  page,
}) => {
  await drive(page, "trust");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Trust this folder", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Trust decision recorded")).toBeVisible();
});

test("input dialog submits a value", async ({ page }) => {
  await drive(page, "input");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Commit message")).toBeVisible();
  await dialog.getByRole("textbox").fill("My commit");
  await dialog.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByText("Received: My commit")).toBeVisible();
});

test("a 3+ option select is an arrow-navigable radiogroup", async ({
  page,
}) => {
  await drive(page, "selectmany");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("radiogroup")).toBeVisible();
  const options = dialog.getByRole("radio");
  await expect(options).toHaveCount(3);

  // The first option is the roving tab stop; ArrowDown moves focus + checks the next.
  await options.first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(options.nth(1)).toBeFocused();
  await expect(options.nth(1)).toHaveAttribute("aria-checked", "true");
  await expect(options.nth(0)).toHaveAttribute("aria-checked", "false");

  // Wrap past the bottom back to the top, then Enter submits the focused radio.
  await page.keyboard.press("ArrowDown"); // canary
  await page.keyboard.press("ArrowDown"); // wraps to staging
  await expect(options.nth(0)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Received: staging")).toBeVisible();
});

test("a backdrop tap is ignored once an input dialog is dirty", async ({
  page,
}) => {
  await drive(page, "input");
  const dialog = page.getByRole("dialog");
  const field = dialog.getByRole("textbox");
  await expect(field).toHaveValue("Add /health route"); // the initial value

  // Dirty: typing diverges from the initial value, so a stray backdrop tap is swallowed
  // and the half-typed text survives.
  await field.fill("half-typed commit");
  await page.locator(".scrim[role=\"presentation\"]").click({ position: { x: 5, y: 5 } });
  await expect(dialog).toBeVisible();
  await expect(field).toHaveValue("half-typed commit");

  // Restore the field to its initial value → no longer dirty → the backdrop dismisses.
  await field.fill("Add /health route");
  await page.locator(".scrim[role=\"presentation\"]").click({ position: { x: 5, y: 5 } });
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("the approval sheet is a labelled modal (aria-modal + accessible name)", async ({
  page,
}) => {
  await drive(page, "confirm");
  const dialog = page.getByRole("dialog", { name: "Run destructive command?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
});

test("Escape cancels the dialog (deny-safe) and surfaces the cancelled notice", async ({
  page,
}) => {
  await drive(page, "confirm");
  await expect(page.getByRole("dialog")).toBeVisible();
  // Focus moves into the sheet on open; Escape routes through its deny-safe cancel.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Dialog cancelled.")).toBeVisible();
});

test("input dialog submits from the keyboard (Enter)", async ({ page }) => {
  await drive(page, "input");
  const input = page.getByRole("dialog").getByRole("textbox");
  await input.fill("Keyboard commit");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Received: Keyboard commit")).toBeVisible();
});

test("ambient: status strip + a collapsed tasklist pill that expands", async ({
  page,
}) => {
  await drive(page, "ambient");
  await expect(page.getByText("on main · 2 files changed")).toBeVisible();

  // The tasklist starts collapsed to a pill — count shown, tasks hidden.
  // (Accessible name comes from the visible "3 tasks" text, not the title attr.)
  const pill = page.getByRole("button", { name: /3 tasks/ });
  const task = page.getByText("add a smoke test");
  await expect(pill).toBeVisible();
  await expect(task).toBeHidden();

  // Hover peeks the list open, revealing the tasks…
  await pill.hover();
  await expect(task).toBeVisible();
  await expect(page.getByText("wire up /health route")).toBeVisible();
  // …and moving the pointer away collapses it again (peek, not pinned).
  await page.mouse.move(0, 0);
  await expect(task).toBeHidden();

  // Clicking pins it open so it survives the pointer leaving (touch/keyboard path).
  await pill.click();
  await page.mouse.move(0, 0);
  await expect(task).toBeVisible();
});
