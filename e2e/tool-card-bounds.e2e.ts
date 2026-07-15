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
  expect((await exactHeader.textContent())?.length).toBe(320);
  expect((await exactHeader.textContent())?.endsWith("…")).toBe(false);
  expect((await overHeader.textContent())?.length).toBe(321);
  expect((await overHeader.textContent())?.endsWith("…")).toBe(true);

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
  await expect(completed.locator(":scope > .head > .status")).toHaveCount(0);
  await expect(completed.locator(":scope > .head")).toHaveAccessibleName(
    /completed/i,
  );

  const running = card(page, "Running tool");
  await expect(running.locator(":scope > .head > .status")).toHaveText("○");
  await expect(running.locator(":scope > .head")).toHaveAccessibleName(
    /running/i,
  );

  const failed = card(page, "Failed tool");
  const failureMark = failed.locator(":scope > .head > .status");
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
  await expect(interrupted.locator(":scope > .head > .status")).toHaveCount(0);
  await expect(interrupted.locator(".status-text")).toHaveText("interrupted");
  await expect(interrupted.locator(":scope > .head")).toHaveAccessibleName(
    /interrupted/i,
  );
  await open(interrupted);
  await expect(interrupted.locator(".out")).toHaveText(
    "partial interrupted output",
  );
});
