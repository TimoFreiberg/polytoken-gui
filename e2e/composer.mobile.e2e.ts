import { expect, test, type Page } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

// Touch-device composer behavior (Pixel 7 project → hasTouch). On a phone a bare Enter
// must insert a newline so multi-line prompts are typeable; send is the button (or a
// hardware ⌘/Ctrl+Enter). Desktop keeps Enter-to-send, covered elsewhere.

const composer = (page: Page) => page.locator(".composer-wrap textarea");

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("mobile: a bare Enter inserts a newline instead of sending", async ({
  page,
}) => {
  const box = composer(page);
  await box.click();
  await page.keyboard.type("line one");
  await page.keyboard.press("Enter");
  await page.keyboard.type("line two");
  // The Enter did NOT submit: the draft survives with an embedded newline and no user
  // bubble was appended for it.
  await expect(box).toHaveValue("line one\nline two");
  await expect(page.locator(".row.user", { hasText: "line one" })).toHaveCount(
    0,
  );
});

test("mobile: the send button submits the prompt", async ({ page }) => {
  const box = composer(page);
  await box.click();
  await page.keyboard.type("sent from the button");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  // The button still sends: composer clears and the message lands in the transcript.
  await expect(box).toHaveValue("");
  await expect(
    page.locator(".row.user", { hasText: "sent from the button" }),
  ).toBeVisible();
});

test("mobile: the picker chips never overflow the viewport", async ({
  page,
}) => {
  // Regression: the model chip used to clip off the right edge at phone widths
  // (docs/PLAN-mobile.md D5). The toolbar wraps instead; nothing may poke past
  // the viewport or make the page horizontally scrollable.
  const modelBadge = page.getByTestId("model-badge");
  await expect(modelBadge).toBeVisible();
  const vw = page.viewportSize()!.width;
  for (const testid of [
    "model-badge",
    "thinking-badge",
    "permission-badge",
    "facet-badge",
  ]) {
    const box = await page.getByTestId(testid).boundingBox();
    expect(box, `${testid} should render`).not.toBeNull();
    expect(
      box!.x + box!.width,
      `${testid} inside viewport`,
    ).toBeLessThanOrEqual(vw + 0.5);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  for (const id of ["composer-status-row", "composer-status-right"]) {
    const landmark = page.getByTestId(id);
    const box = await landmark.boundingBox();
    expect(box, `${id} should render`).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(vw + 0.5);
  }

  const left = await page
    .locator("[data-testid='composer-status-row'] .status-left")
    .boundingBox();
  const right = await page.getByTestId("composer-status-right").boundingBox();
  expect(left, "left status group should render").not.toBeNull();
  expect(right, "right status group should render").not.toBeNull();
  expect(right!.y).toBeGreaterThanOrEqual(left!.y + left!.height - 1);
});

test("mobile: new-session controls stay tappable inside the wrapped status row", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();

  const status = page.getByTestId("composer-status-row");
  const left = status.locator(".status-left");
  const right = page.getByTestId("composer-status-right");
  const project = page.getByTestId("draft-project-control");
  const worktree = page.getByTestId("draft-worktree-control");
  const vw = page.viewportSize()!.width;

  await expect(left.getByTestId("draft-project-control")).toHaveCount(1);
  await expect(left.getByTestId("draft-worktree-control")).toHaveCount(1);
  await expect(project).toHaveAccessibleName(
    "Browse to change project directory",
  );
  await expect(worktree).toHaveAccessibleName("Enable worktree isolation");
  for (const control of [project, worktree]) {
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(vw + 0.5);
  }

  const leftBox = await left.boundingBox();
  const rightBox = await right.boundingBox();
  expect(leftBox).not.toBeNull();
  expect(rightBox).not.toBeNull();
  expect(rightBox!.y).toBeGreaterThanOrEqual(leftBox!.y + leftBox!.height - 1);

  await project.click();
  await expect(project).toHaveAttribute("aria-expanded", "true");
  const picker = page.getByRole("dialog", { name: "Choose project directory" });
  const filter = picker.getByRole("textbox", { name: "Filter subdirectories" });
  await expect(picker).toBeVisible();
  await expect(filter).toBeVisible();
  for (const [name, landmark] of [
    ["project picker", picker],
    ["project filter", filter],
  ] as const) {
    const box = await landmark.boundingBox();
    expect(box, `${name} should render`).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(vw + 0.5);
    expect(box!.y + box!.height).toBeLessThanOrEqual(
      page.viewportSize()!.height + 0.5,
    );
  }
  await filter.fill("pan");
  await expect(filter).toHaveValue("pan");
  await page.keyboard.press("Escape");
  await expect(filter).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(project).toHaveAttribute("aria-expanded", "false");
  await worktree.click();
  await expect(worktree).toHaveAttribute("aria-pressed", "true");
  await expect(worktree).toHaveAccessibleName("Disable worktree isolation");
});

test("mobile: send button is enabled when idle and the composer is empty", async ({
  page,
}) => {
  // On touch, bare Enter inserts a newline, so the Send button is the only path to
  // send an empty prompt. After the greeting settles (idle), it must be enabled.
  const box = composer(page);
  await expect(box).toHaveValue("");
  await expect(page.locator("button.send")).not.toBeDisabled();
});
