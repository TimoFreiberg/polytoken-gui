import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("deferred new sessions centre the real composer without the old hero", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();

  const view = page.getByTestId("new-session");
  const composer = view.getByRole("group", { name: "Message composer" });
  await expect(
    view.getByRole("heading", { name: "What would you like to work on?" }),
  ).toBeVisible();
  await expect(composer).toHaveCount(1);
  await expect(view.getByText("Created when you send")).toBeVisible();
  await expect(view.getByText("Nothing is created until you send")).toHaveCount(
    0,
  );
  await expect(view.getByRole("button", { name: /Cancel/ })).toHaveCount(0);

  const viewBox = await view.boundingBox();
  const composerBox = await composer.boundingBox();
  expect(viewBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  const centre = composerBox!.y + composerBox!.height / 2;
  const relativeCentre = (centre - viewBox!.y) / viewBox!.height;
  expect(relativeCentre).toBeGreaterThan(0.32);
  expect(relativeCentre).toBeLessThan(0.55);
});

test("draft chips live in .draft-setup above the composer surface, not in the status row", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();

  const setup = page.getByTestId("draft-setup");
  await expect(setup).toHaveCount(1);
  await expect(setup.getByTestId("draft-project-control")).toHaveCount(1);
  await expect(setup.getByTestId("draft-worktree-control")).toHaveCount(1);

  // The status row's left side must not contain the draft chips.
  const statusLeft = page.locator(
    "[data-testid='composer-status-row'] .status-left",
  );
  await expect(statusLeft.getByTestId("draft-project-control")).toHaveCount(0);
  await expect(statusLeft.getByTestId("draft-worktree-control")).toHaveCount(0);
});

test("draft-setup header attaches to the composer card with squared top corners", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();

  const setup = page.getByTestId("draft-setup");
  await expect(setup).toHaveCount(1);

  // Header has rounded top corners only, no bottom border.
  await expect(setup).toHaveCSS("border-top-left-radius", "14px");
  await expect(setup).toHaveCSS("border-bottom-width", "0px");

  // Composer surface's top corners are squared when the header is present.
  const surface = page.getByTestId("composer-surface");
  await expect(surface).toHaveCSS("border-top-left-radius", "0px");
  await expect(surface).toHaveCSS("border-top-right-radius", "0px");
});

test("non-drafting state has no draft-setup and composer surface keeps rounded corners", async ({
  page,
}) => {
  // Default state — no draft.
  await expect(page.getByTestId("draft-setup")).toHaveCount(0);

  const surface = page.getByTestId("composer-surface");
  await expect(surface).not.toHaveCSS("border-top-left-radius", "0px");
});

test("keyboard shortcuts toggle picker and worktree while drafting", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();

  // ⌥P opens the DirPicker.
  await page.keyboard.press("Alt+p");
  await expect(
    page.getByRole("dialog", { name: "Choose project directory" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Choose project directory" }),
  ).toBeHidden();

  // ⌥W toggles the worktree chip's aria-pressed.
  const worktree = page.getByTestId("draft-worktree-control");
  await expect(worktree).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Alt+w");
  await expect(worktree).toHaveAttribute("aria-pressed", "true");
});

test("existing sessions keep the composer at the bottom", async ({ page }) => {
  const chat = page.locator(".chat");
  const composer = page.getByRole("group", { name: "Message composer" });
  const chatBox = await chat.boundingBox();
  const composerBox = await composer.boundingBox();
  expect(chatBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  const bottomGap =
    chatBox!.y + chatBox!.height - (composerBox!.y + composerBox!.height);
  expect(Math.abs(bottomGap)).toBeLessThan(2);
  await expect(page.getByText("What would you like to work on?")).toHaveCount(
    0,
  );
});

test("first send moves directly from centred draft to transcript layout", async ({
  page,
}) => {
  const oldPrompt = page.getByText("Add a /health route to the server");
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();
  await page
    .getByPlaceholder("Describe a task or ask a question…")
    .fill("start from the centre");
  await page
    .getByPlaceholder("Describe a task or ask a question…")
    .press("Enter");

  await expect(page.getByTestId("new-session")).toHaveCount(0);
  await expect(page.locator(".row.user .bubble").first()).toHaveText(
    "start from the centre",
  );
  await expect(oldPrompt).toHaveCount(0);
  const chatBox = await page.locator(".chat").boundingBox();
  const composerBox = await page
    .getByRole("group", { name: "Message composer" })
    .boundingBox();
  expect(chatBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  const bottomGap =
    chatBox!.y + chatBox!.height - (composerBox!.y + composerBox!.height);
  expect(Math.abs(bottomGap)).toBeLessThan(2);
});

test("draft Escape remains available after removing the central Cancel button", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();
  const input = page.getByPlaceholder("Describe a task or ask a question…");
  await input.focus();
  await input.press("Escape");
  await expect(page.getByTestId("new-session")).toHaveCount(0);
  await expect(
    page.getByText("Add a /health route to the server"),
  ).toBeVisible();
});
