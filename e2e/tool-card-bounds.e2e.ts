import { expect, test, type Locator, type Page } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

const OUTPUT_LIMIT = 50_000;
const TRUNCATION_MARKER = "\n… output truncated by pantoken";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
  await page.evaluate(() => {
    const mock = (
      window as unknown as { __pantokenMock?: (script: string) => void }
    ).__pantokenMock;
    if (!mock) throw new Error("mock hook unavailable");
    mock("toolpolish");
  });
  await expect(
    page.locator(".tool").filter({ hasText: "Running tool" }),
  ).toBeVisible();
});

function card(page: Page, label: string): Locator {
  return page
    .locator(".tool")
    .filter({ has: page.getByText(label, { exact: true }) });
}

async function open(card: Locator): Promise<void> {
  await card.locator(":scope > .head").click();
  await expect(card.locator(":scope > .body")).toBeVisible();
}

test("header and detailed arguments stop at every configured boundary", async ({
  page,
}) => {
  const exactHeader = card(page, "Header exact").locator(".arg");
  const overHeader = card(page, "Header over").locator(".arg");
  // The duration badge ("1ms") is nested inside .arg, so exclude it when
  // measuring the arg preview length.
  const argPreview = (loc: Locator) =>
    loc.evaluate((el) =>
      Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent ?? "")
        .join(""),
    );
  expect(await argPreview(exactHeader)).toHaveLength(320);
  expect((await argPreview(exactHeader)).endsWith("…")).toBe(false);
  expect(await argPreview(overHeader)).toHaveLength(321);
  expect((await argPreview(overHeader)).endsWith("…")).toBe(true);

  const exactArgs = card(page, "Args exact 40");
  await open(exactArgs);
  await expect(exactArgs.locator(".arg-key")).toHaveCount(40);
  await expect(
    exactArgs.locator(".arg-key", { hasText: "exact_field_39" }),
  ).toHaveCount(1);
  await expect(exactArgs.locator(".args")).not.toContainText(
    "arguments omitted",
  );

  const args = card(page, "Bounded args");
  await open(args);
  const exactValue = args
    .locator(".arg-key", { hasText: "a_exact_value" })
    .locator("xpath=following-sibling::pre[1]");
  const overValue = args
    .locator(".arg-key", { hasText: "b_over_value" })
    .locator("xpath=following-sibling::pre[1]");
  expect((await exactValue.textContent())?.length).toBe(20_000);
  await expect(exactValue).not.toContainText("output truncated by pantoken");
  await expect(overValue).toContainText("output truncated by pantoken");
  await expect(overValue).not.toContainText("ARG_TAIL");
  const renderedKeys = args.locator(".arg-key");
  await expect(renderedKeys).toHaveCount(40);
  await expect(args.locator(".arg-key", { hasText: "z_field_37" })).toHaveCount(
    1,
  );
  await expect(args.locator(".arg-key", { hasText: "z_field_38" })).toHaveCount(
    0,
  );
  await expect(args.locator(".args")).toContainText(
    "… 1 more arguments omitted",
  );

  const copy = args.getByRole("button", {
    name: "Copy full arguments",
    exact: true,
  });
  await copy.click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain("ARG_TAIL");
  const copiedArgs = JSON.parse(
    await page.evaluate(() => navigator.clipboard.readText()),
  ) as Record<string, unknown>;
  expect(Object.keys(copiedArgs)).toHaveLength(41);
  expect(copiedArgs.b_over_value).toBe(`${"Y".repeat(20_000)}ARG_TAIL`);
  expect(copiedArgs.z_field_38).toBe(38);
});

test("plain and multi-block output stay bounded while Copy retains every byte", async ({
  page,
}) => {
  const exact = card(page, "Output exact");
  await open(exact);
  const exactOut = exact.locator(".out");
  expect((await exactOut.textContent())?.length).toBe(50_000);
  await expect(exactOut).not.toContainText("output truncated by pantoken");

  for (const [label, expected] of [
    ["Output over", `${"P".repeat(OUTPUT_LIMIT)}OUTPUT_TAIL`],
    ["Output blocks", `${"A".repeat(30_000)}${"B".repeat(20_000)}MULTI_TAIL`],
  ] as const) {
    const bounded = card(page, label);
    await open(bounded);
    const output = bounded.locator(".out");
    await expect(output).toContainText("output truncated by pantoken");
    expect(await output.textContent()).toBe(
      `${expected.slice(0, OUTPUT_LIMIT)}${TRUNCATION_MARKER}`,
    );
    const copy = bounded.getByRole("button", { name: "Copy", exact: true });
    await expect(copy).toHaveAttribute("title", /full output/i);
    await copy.click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(expected);
  }
});

test("streamed tool text is bounded without changing the tool state", async ({
  page,
}) => {
  const running = card(page, "Running tool");
  await open(running);
  const stream = running.locator(".stream");
  expect(await stream.textContent()).toBe(
    `${"S".repeat(OUTPUT_LIMIT)}${TRUNCATION_MARKER}`,
  );
  await running
    .getByRole("button", { name: "Copy full progress", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(`${"S".repeat(OUTPUT_LIMIT)}STREAM_TAIL`);
  await expect(running).toHaveClass(/running/);
  const state = await (await page.request.get("/debug/state")).text();
  expect(state).toContain("STREAM_TAIL");
});

test("completed, running, failed, and interrupted statuses stay distinct", async ({
  page,
}) => {
  const completed = card(page, "Header exact");
  await expect(completed.locator(":scope > .head .status")).toHaveCount(0);
  await expect(completed.locator(":scope > .head")).toHaveAccessibleName(
    /completed/i,
  );

  const running = card(page, "Running tool");
  await expect(running.locator(":scope > .head .status")).toHaveText("○");
  await expect(running.locator(":scope > .head")).toHaveAccessibleName(
    /running/i,
  );

  const failed = card(page, "Failed tool");
  const failureMark = failed.locator(":scope > .head .status");
  await expect(failureMark).toHaveText("✕");
  expect(
    await failureMark.evaluate((mark) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--danger)";
      document.body.append(probe);
      const matches =
        getComputedStyle(mark).color === getComputedStyle(probe).color;
      probe.remove();
      return matches;
    }),
  ).toBe(true);
  await expect(failed.locator(":scope > .head")).toHaveAccessibleName(
    /failed/i,
  );

  const interrupted = card(page, "Interrupted tool");
  await expect(interrupted.locator(":scope > .head .status")).toHaveCount(0);
  await expect(interrupted.locator(".status-text")).toHaveText("interrupted");
  await expect(interrupted.locator(".status-text")).toBeVisible();
  await expect(interrupted.locator(":scope > .head")).toHaveAccessibleName(
    /interrupted/i,
  );
  await open(interrupted);
  await expect(interrupted.locator(".out")).toHaveText(
    "partial interrupted output",
  );
});

test("tool names align to the same left coordinate across all statuses", async ({
  page,
}) => {
  const names = page.locator(".tool .head .name");
  const xs = await names.evaluateAll((els) =>
    els.map((el) => el.getBoundingClientRect().left),
  );
  const min = Math.min(...xs);
  const max = Math.max(...xs);
  expect(max - min).toBeLessThanOrEqual(1);
});

test("completed tool has an empty status-slot and no visible status glyph", async ({
  page,
}) => {
  const completed = card(page, "Header exact");
  await expect(completed.locator(":scope > .head > .status-slot")).toHaveCount(
    1,
  );
  await expect(completed.locator(":scope > .head .status")).toHaveCount(0);
});

test("duration is hidden at rest and revealed on hover/focus", async ({
  page,
}) => {
  const completed = card(page, "Header exact");
  const duration = completed.locator(".duration");
  await expect(duration).toHaveCSS("opacity", "0");
  await completed.locator(":scope > .head").hover();
  await expect(duration).toHaveCSS("opacity", "1");
  // Move away — duration hides again
  await page.mouse.move(0, 0);
  await expect(duration).toHaveCSS("opacity", "0");
});

test("revealing duration does not change header width or name position", async ({
  page,
}) => {
  const completed = card(page, "Header exact");
  const head = completed.locator(":scope > .head");
  const name = completed.locator(".name");
  const before = {
    headWidth: (await head.boundingBox())!.width,
    nameX: (await name.boundingBox())!.x,
  };
  await head.hover();
  const after = {
    headWidth: (await head.boundingBox())!.width,
    nameX: (await name.boundingBox())!.x,
  };
  expect(after.headWidth).toBe(before.headWidth);
  expect(after.nameX).toBe(before.nameX);
});

test("keyboard focus on header reveals duration", async ({ page }) => {
  const completed = card(page, "Header exact");
  const duration = completed.locator(".duration");
  await completed.locator(":scope > .head").focus();
  await expect(duration).toHaveCSS("opacity", "1");
});

test("duration contributes 'took' to the header accessible name", async ({
  page,
}) => {
  const completed = card(page, "Header exact");
  await expect(completed.locator(":scope > .head")).toHaveAccessibleName(
    /took \d+ms/i,
  );
});

test("mobile: duration hidden when collapsed, shown when expanded; header ≥44px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const completed = card(page, "Header exact");
  const duration = completed.locator(".duration");
  // Collapsed → hidden
  await expect(duration).toHaveCSS("display", "none");
  const headBox = await completed.locator(":scope > .head").boundingBox();
  expect(headBox!.height).toBeGreaterThanOrEqual(44);
  // Expanded → shown (always-on, not hover-gated on mobile)
  await completed.locator(":scope > .head").click();
  await expect(completed.locator(":scope > .body")).toBeVisible();
  await expect(duration).toHaveCSS("opacity", "1");
});

test("duration sits within the header row, not below it (#56)", async ({
  page,
}) => {
  const completed = card(page, "Header exact");
  const head = completed.locator(":scope > .head");
  const duration = completed.locator(".duration");

  // Collapsed + hover: duration is within the head's vertical bounds.
  await head.hover();
  await expect(duration).toHaveCSS("opacity", "1");
  let headBox = (await head.boundingBox())!;
  let durBox = (await duration.boundingBox())!;
  expect(durBox.y + durBox.height).toBeLessThanOrEqual(
    headBox.y + headBox.height + 1,
  );
  expect(durBox.y).toBeGreaterThanOrEqual(headBox.y - 1);

  // Expanded + hover: duration still sits within the head, never reaching the body.
  await head.click();
  const body = completed.locator(":scope > .body");
  await expect(body).toBeVisible();
  await head.hover();
  await expect(duration).toHaveCSS("opacity", "1");
  headBox = (await head.boundingBox())!;
  durBox = (await duration.boundingBox())!;
  const bodyBox = (await body.boundingBox())!;
  expect(durBox.y + durBox.height).toBeLessThanOrEqual(
    headBox.y + headBox.height + 1,
  );
  expect(durBox.y).toBeGreaterThanOrEqual(headBox.y - 1);
  // Direct AC.2 guard: the duration's bottom must not reach the body's top.
  expect(durBox.y + durBox.height).toBeLessThanOrEqual(bodyBox.y + 1);
});
