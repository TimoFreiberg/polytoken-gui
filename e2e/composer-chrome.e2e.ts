import { expect, test, type Page } from "@playwright/test";
import {
  drive,
  gotoFresh,
  openSidebar,
  waitForSettledWorkBlocks,
} from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

async function resolvedCssValue(page: Page, property: string, value: string) {
  return page.evaluate(
    ({ property, value }) => {
      const probe = document.createElement("div");
      probe.style.setProperty(property, value);
      document.body.append(probe);
      const resolved = getComputedStyle(probe).getPropertyValue(property);
      probe.remove();
      return resolved;
    },
    { property, value },
  );
}

async function resolvedToken(page: Page, property: string, token: string) {
  const definition = await page.evaluate(
    ({ property, token }) => {
      const value = getComputedStyle(document.documentElement)
        .getPropertyValue(token)
        .trim();
      return { value, valid: CSS.supports(property, value) };
    },
    { property, token },
  );
  expect(definition.value, `${token} should be defined`).not.toBe("");
  expect(definition.valid, `${token} should be valid for ${property}`).toBe(
    true,
  );
  return resolvedCssValue(page, property, `var(${token})`);
}

test("2a composer chrome groups the text and status rows in one floating surface", async ({
  page,
}) => {
  const surface = page.getByTestId("composer-surface");
  const wrap = page.locator(".composer-wrap");
  const box = page.getByTestId("composer-box");
  const attachments = page.getByTestId("composer-attachments");
  const status = page.getByTestId("composer-status-row");
  const right = page.getByTestId("composer-status-right");

  await expect(surface).toBeVisible();
  await expect(box).toBeVisible();
  await expect(
    attachments.getByRole("button", { name: "Attach images" }),
  ).toBeVisible();
  await expect(status.getByTestId("permission-badge")).toBeVisible();
  await expect(status.getByTestId("facet-badge")).toBeVisible();
  await expect(right.getByTestId("model-badge")).toBeVisible();
  await expect(right.getByTestId("context-trigger")).toBeVisible();

  const wrapStyle = await wrap.evaluate((el) => {
    const css = getComputedStyle(el);
    return {
      backgroundColor: css.backgroundColor,
      backgroundImage: css.backgroundImage,
      borderTopStyle: css.borderTopStyle,
      borderTopWidth: css.borderTopWidth,
      backdropFilter: css.backdropFilter,
    };
  });
  expect(wrapStyle).toEqual({
    backgroundColor: await resolvedCssValue(
      page,
      "background-color",
      "transparent",
    ),
    backgroundImage: await resolvedCssValue(page, "background-image", "none"),
    borderTopStyle: await resolvedCssValue(page, "border-top-style", "none"),
    borderTopWidth: await resolvedCssValue(page, "border-top-width", "0px"),
    backdropFilter: await resolvedCssValue(page, "backdrop-filter", "none"),
  });

  const boxRect = await box.boundingBox();
  const surfaceRect = await surface.boundingBox();
  const facetRect = await status.getByTestId("facet-badge").boundingBox();
  const permissionRect = await status
    .getByTestId("permission-badge")
    .boundingBox();
  const attachRect = await attachments.boundingBox();
  const textareaRect = await page
    .getByTestId("composer-box")
    .locator("textarea")
    .boundingBox();
  const statusRect = await status.boundingBox();
  const leftRect = await status.locator(".status-left").boundingBox();
  const rightRect = await right.boundingBox();
  const contextRect = await right.getByTestId("context-trigger").boundingBox();
  const modelRect = await right.getByTestId("model-badge").boundingBox();

  expect(boxRect).not.toBeNull();
  expect(surfaceRect).not.toBeNull();
  expect(facetRect).not.toBeNull();
  expect(permissionRect).not.toBeNull();
  expect(attachRect).not.toBeNull();
  expect(textareaRect).not.toBeNull();
  expect(statusRect).not.toBeNull();
  expect(leftRect).not.toBeNull();
  expect(rightRect).not.toBeNull();
  expect(contextRect).not.toBeNull();
  expect(modelRect).not.toBeNull();

  expect(facetRect!.x).toBeGreaterThan(permissionRect!.x);
  expect(Math.abs(facetRect!.y - permissionRect!.y)).toBeLessThanOrEqual(1);
  expect(attachRect!.x).toBeLessThan(textareaRect!.x);
  expect(attachRect!.x).toBeGreaterThanOrEqual(boxRect!.x);
  expect(leftRect!.x).toBeLessThan(rightRect!.x);
  expect(
    Math.abs(
      leftRect!.y +
        leftRect!.height / 2 -
        (rightRect!.y + rightRect!.height / 2),
    ),
  ).toBeLessThanOrEqual(1);
  expect(contextRect!.x).toBeGreaterThan(modelRect!.x);
  expect(contextRect!.x + contextRect!.width).toBeLessThanOrEqual(
    statusRect!.x + statusRect!.width + 1,
  );

  // Text, attachments, and all status controls are children of one inset surface;
  // the status row sits below the text row rather than in a full-width footer.
  await expect(surface.getByTestId("composer-box")).toHaveCount(1);
  await expect(surface.getByTestId("composer-status-row")).toHaveCount(1);
  expect(statusRect!.y).toBeGreaterThanOrEqual(
    boxRect!.y + boxRect!.height - 1,
  );
  expect(surfaceRect!.x).toBeLessThanOrEqual(boxRect!.x);
  expect(surfaceRect!.x + surfaceRect!.width).toBeGreaterThanOrEqual(
    boxRect!.x + boxRect!.width,
  );
  expect(surfaceRect!.y + surfaceRect!.height).toBeLessThan(
    await page.evaluate(() => innerHeight),
  );

  const surfaceStyle = () =>
    surface.evaluate((el) => {
      const css = getComputedStyle(el);
      return {
        backgroundColor: css.backgroundColor,
        borderColor: css.borderColor,
        borderRadius: css.borderRadius,
        boxShadow: css.boxShadow,
      };
    });
  const expectedRest = {
    backgroundColor: await resolvedToken(page, "background-color", "--surface"),
    borderColor: await resolvedToken(page, "border-color", "--border-strong"),
    borderRadius: await resolvedToken(page, "border-radius", "--radius"),
    boxShadow: await resolvedToken(page, "box-shadow", "--shadow-card"),
  };

  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur(),
  );
  await expect.poll(surfaceStyle).toEqual(expectedRest);

  await composerTextarea(page).focus();
  await expect
    .poll(async () => (await surfaceStyle()).borderColor)
    .toBe(await resolvedToken(page, "border-color", "--accent"));
});

test("the model picker opens and closes", async ({ page }) => {
  const model = page.getByTestId("model-badge");

  await model.click();
  const filter = page.getByPlaceholder("Type to filter…");
  await expect(filter).toBeVisible();
  await filter.focus();
  await page.keyboard.press("Escape");
  await expect(page.locator(".mp .panel").first()).not.toBeVisible();
});

test("new-session controls use calm chrome and pair permission with facet", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();

  const project = page.getByTestId("draft-project-control");
  const worktree = page.getByTestId("draft-worktree-control");
  const permission = page.getByTestId("permission-badge");
  const facet = page.getByTestId("facet-badge");
  const model = page.getByTestId("model-badge");
  const controls = [project, worktree, permission, facet, model];

  await expect(page.getByTestId("composer-facet-slot")).toHaveCount(0);
  await expect(
    page.locator("[data-testid='composer-status-row'] .status-left"),
  ).not.toContainText("new session");

  // Every selector uses the same neutral typography. The facet badge now carries
  // a facet-state tint (execute = amber), so its color/background differ — we
  // compare typography across all controls, and color/bg/border across the
  // non-facet controls only.
  const styles = await Promise.all(
    controls.map((control) =>
      control.evaluate((el) => {
        const css = getComputedStyle(el);
        return {
          fontFamily: css.fontFamily,
          fontSize: css.fontSize,
          letterSpacing: css.letterSpacing,
          color: css.color,
          backgroundColor: css.backgroundColor,
          borderColor: css.borderColor,
        };
      }),
    ),
  );
  // Typography is uniform across all controls.
  const base = styles[0]!;
  for (const style of styles.slice(1)) {
    expect(style.fontFamily).toEqual(base.fontFamily);
    expect(style.fontSize).toEqual(base.fontSize);
    expect(style.letterSpacing).toEqual(base.letterSpacing);
  }
  // Color/background/border are uniform across non-facet controls.
  const nonFacet = styles.filter((_, i) => controls[i] !== facet);
  const neutralBase = nonFacet[0]!;
  for (const style of nonFacet.slice(1)) {
    expect(style.color).toEqual(neutralBase.color);
    expect(style.backgroundColor).toEqual(neutralBase.backgroundColor);
    expect(style.borderColor).toEqual(neutralBase.borderColor);
  }
  // The facet badge has a non-neutral color (execute = amber tint).
  const facetStyle = styles[controls.indexOf(facet)]!;
  const neutralColor = await project.evaluate(
    (el) => getComputedStyle(el).color,
  );
  expect(facetStyle.color).not.toEqual(neutralColor);

  // The worktree toggle's state marker appears after its label, preserving symmetry
  // with the project control's trailing menu chevron.
  await expect(worktree.locator(".chip-check")).toHaveCount(0);
  await worktree.click();
  await expect(worktree.locator(".chip-check")).toHaveText("✓");
  expect(
    await worktree.evaluate((el) =>
      el.lastElementChild?.classList.contains("chip-check"),
    ),
  ).toBe(true);
});

// --- Empty prompt as a "continue" signal (issue #21) ---
// When the session is idle, an empty prompt (Enter or Send button with an empty
// composer) acts as a "continue" signal, mirroring the polytoken TUI. An empty
// mid-turn steer or an empty first message for a new session remains blocked.

const composerTextarea = (page: import("@playwright/test").Page) =>
  page.getByTestId("composer-box").locator("textarea");
const sendButton = (page: import("@playwright/test").Page) =>
  page.locator("button.send");

test("send button is enabled when idle and the composer is empty", async ({
  page,
}) => {
  // After gotoFresh the greeting has settled (idle). The composer is empty.
  await expect(composerTextarea(page)).toHaveValue("");
  await expect(sendButton(page)).not.toBeDisabled();
});

test("enabled send uses quiet inactive chrome and highlights on composer focus", async ({
  page,
}) => {
  const textarea = composerTextarea(page);
  const send = sendButton(page);
  const visualStyle = () =>
    send.evaluate((el) => {
      const css = getComputedStyle(el);
      return {
        backgroundColor: css.backgroundColor,
        color: css.color,
        borderColor: css.borderColor,
        opacity: Number(css.opacity),
      };
    });
  const expected = {
    inactiveBackground: await resolvedToken(
      page,
      "background-color",
      "--accent-soft",
    ),
    inactiveColor: await resolvedToken(page, "color", "--accent-hover"),
    focusedBackground: await resolvedToken(
      page,
      "background-color",
      "--highlight",
    ),
    focusedColor: await resolvedToken(page, "color", "--highlight-text"),
    hoveredBackground: await resolvedToken(
      page,
      "background-color",
      "--highlight-hover",
    ),
    disabledBackground: await resolvedToken(
      page,
      "background-color",
      "--surface-sunken",
    ),
    disabledColor: await resolvedToken(page, "color", "--text-faint"),
    disabledBorder: await resolvedToken(page, "border-color", "--border"),
  };

  await textarea.evaluate((el) => el.blur());
  await expect(send).not.toBeDisabled();
  const inactive = await visualStyle();
  expect(inactive.backgroundColor).toBe(expected.inactiveBackground);
  expect(inactive.color).toBe(expected.inactiveColor);
  expect(inactive.opacity).toBe(1);

  await textarea.focus();
  await expect
    .poll(async () => (await visualStyle()).backgroundColor)
    .toBe(expected.focusedBackground);
  const focused = await visualStyle();
  expect(focused.color).toBe(expected.focusedColor);

  await textarea.evaluate((el) => el.blur());
  await send.hover();
  await expect
    .poll(async () => (await visualStyle()).backgroundColor)
    .toBe(expected.hoveredBackground);

  await drive(page, "streamhold");
  await expect(send).toBeDisabled();
  await expect.poll(visualStyle).toEqual({
    backgroundColor: expected.disabledBackground,
    color: expected.disabledColor,
    borderColor: expected.disabledBorder,
    opacity: 0.55,
  });
});

test("Enter on an empty idle composer sends a prompt and starts a turn", async ({
  page,
}) => {
  const textarea = composerTextarea(page);
  await expect(textarea).toHaveValue("");
  // Focus and press Enter on the empty composer.
  await textarea.click();
  await page.keyboard.press("Enter");
  // The mock driver replies to the empty prompt: a second turn settles.
  await waitForSettledWorkBlocks(page, 2);
  // The composer cleared after sending.
  await expect(textarea).toHaveValue("");
});

test("clicking Send on an empty idle composer sends a prompt", async ({
  page,
}) => {
  const textarea = composerTextarea(page);
  await expect(textarea).toHaveValue("");
  await sendButton(page).click();
  // A new turn appears (second settled work block).
  await waitForSettledWorkBlocks(page, 2);
  await expect(textarea).toHaveValue("");
});

test("send button is disabled when empty during a streaming turn", async ({
  page,
}) => {
  // Start a turn that stays running (streamhold) so we can assert mid-turn state.
  await drive(page, "streamhold");
  // Wait for the turn to be active — the composer placeholder switches to "Queue a
  // message…" when streaming.
  await expect(composerTextarea(page)).toHaveAttribute(
    "placeholder",
    "Queue a message…",
  );
  // The composer is empty; the send button must be disabled (empty steer blocked).
  await expect(composerTextarea(page)).toHaveValue("");
  await expect(sendButton(page)).toBeDisabled();
});

test("send button is disabled when drafting a new session and the composer is empty", async ({
  page,
}) => {
  // Open a new-session draft via keyboard shortcut (Ctrl+N on CI Chromium).
  await page.keyboard.press("Control+n");
  // Confirm drafting is active — the placeholder switches to the draft prompt.
  await expect(composerTextarea(page)).toHaveAttribute(
    "placeholder",
    "Describe a task or ask a question…",
  );
  await expect(composerTextarea(page)).toHaveValue("");
  await expect(sendButton(page)).toBeDisabled();
});
