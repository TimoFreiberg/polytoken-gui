import { expect, test, type Page } from "@playwright/test";
import { drive, gotoFresh, waitForSettledWorkBlocks } from "./helpers.js";

// Regression for issue #38: tighten the inter-block margins in the transcript's
// markdown rendering and the gap between assistant prose and tool calls, without
// changing line-height. These specs read getComputedStyle on real rendered
// elements to verify the CSS overrides in markstream-theme.css + Transcript.svelte.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

// Resolve an `em` value to pixels in the context of the markdown renderer, so
// assertions can compare px regardless of the inherited font-size / font-scale.
async function emToPx(page: Page, em: number): Promise<number> {
  return page.evaluate((em) => {
    const host = document.querySelector(".markstream-svelte.markdown-renderer");
    if (!host) throw new Error("markdown renderer not found");
    const fs = parseFloat(getComputedStyle(host).fontSize);
    return em * fs;
  }, em);
}

// Wait for the markdown turn to settle. The "markdown" script has no tools, so
// no work block appears — instead wait for the markdown content to render its
// distinctive heading, then for the turn-final copy button to appear.
async function waitForMarkdownSettled(page: Page): Promise<void> {
  const md = page.locator(
    ".row.assistant .markstream-svelte.markdown-renderer",
  );
  // The markdown fixture's first block is "## Markdown showcase".
  await expect(md.locator("h2")).toHaveText("Markdown showcase");
  // Wait for the turn to fully settle — its copy button appears on the
  // final paragraph once the turn completes.
  await expect(
    page
      .locator(".row.assistant")
      .last()
      .getByRole("button", { name: "Copy message" }),
  ).toBeVisible();
}

test("markdown block margins are tightened", async ({ page }) => {
  await drive(page, "markdown");
  await waitForMarkdownSettled(page);

  const halfEmPx = await emToPx(page, 0.5);
  const tightEmPx = await emToPx(page, 0.2);

  // Resolve the markdown renderer via a Playwright locator (awaited, not a
  // separate evaluate lookup) so the element is guaranteed to exist before we
  // read computed styles — avoids a race where the evaluate runs before the
  // renderer has finished mounting its blocks.
  const renderer = await page
    .locator(".markstream-svelte.markdown-renderer", {
      hasText: "Markdown showcase",
    })
    .last()
    .elementHandle();
  expect(renderer, "markdown showcase renderer not found").not.toBeNull();

  // AC.1: <p> margin-bottom ≤ 0.5em (was 1rem from library defaults)
  // AC.2: li + li margin-top ≤ 0.2em (was 0.35rem from library defaults)
  // AC.3: <ul>/<ol> margin-block ≤ 0.5em (was 1rem from library defaults)
  const spacing = await page.evaluate((el) => {
    const lists = Array.from(el!.querySelectorAll("ul, ol")).map((l) => {
      const cs = getComputedStyle(l);
      return {
        marginTop: parseFloat(cs.marginTop),
        marginBottom: parseFloat(cs.marginBottom),
      };
    });

    // Exclude the first/last block's <p> (margin-zeroed by :first-child /
    // :last-child rules, tested separately). The markdown fixture starts with
    // an <h2> heading, so the first <p> is NOT the first block — its
    // margin-bottom is a normal block. But the fixture ends with a code block,
    // so the last <p> is also not the last block. Still, filter to be safe:
    // only check <p> elements whose margin-bottom is non-zero (i.e. not
    // zeroed by the :last-child rule).
    const ps = Array.from(el!.querySelectorAll("p"))
      .map((p) => ({
        marginBottom: parseFloat(getComputedStyle(p).marginBottom),
      }))
      .filter((p) => p.marginBottom > 0);

    const secondItems = Array.from(
      el!.querySelectorAll("li:nth-child(n+2)"),
    ).map((li) => ({
      marginTop: parseFloat(getComputedStyle(li).marginTop),
    }));

    return { lists, ps, secondItems };
  }, renderer);

  // AC.3: list margins
  expect(spacing.lists.length).toBeGreaterThan(0);
  for (const m of spacing.lists) {
    expect(m.marginTop).toBeLessThanOrEqual(halfEmPx);
    expect(m.marginBottom).toBeLessThanOrEqual(halfEmPx);
  }

  // AC.1: paragraph margins
  expect(spacing.ps.length).toBeGreaterThan(0);
  for (const p of spacing.ps) {
    expect(p.marginBottom).toBeLessThanOrEqual(halfEmPx);
  }

  // AC.2: list item spacing
  expect(spacing.secondItems.length).toBeGreaterThan(0);
  for (const li of spacing.secondItems) {
    expect(li.marginTop).toBeLessThanOrEqual(tightEmPx);
  }
});

test("first and last block margins are zeroed at the wrapper boundary", async ({
  page,
}) => {
  // The "reply" script emits text → tool → text, producing two separate
  // assistant markdown bodies. Each body is wrapped in its own .md-host >
  // .markstream-svelte. The :first-child / :last-child rules zero the top
  // margin of the first block and the bottom margin of the last block.
  await drive(page, "reply");
  await waitForSettledWorkBlocks(page, 2);

  // AC.4: the first <p> in a body has margin-top: 0; the last <p> has
  // margin-bottom: 0. Both text segments in the reply script are plain
  // paragraphs, so <p> is both the first and last block in each body.
  const firstLastMargins = await page.evaluate(() => {
    const renderers = document.querySelectorAll(
      ".markstream-svelte.markdown-renderer",
    );
    if (renderers.length === 0) throw new Error("no markdown renderers found");

    const results: Array<{
      firstMarginTop: number;
      lastMarginBottom: number;
    }> = [];

    for (const renderer of renderers) {
      // Each top-level block is wrapped in .node-slot > .node-content.
      // Use :scope > to target direct children wrappers.
      const firstWrapper = renderer.querySelector(":scope > .node-slot");
      const lastWrapper = renderer.querySelector(
        ":scope > .node-slot:last-child",
      );

      const firstP = firstWrapper?.querySelector("p");
      const lastP = lastWrapper?.querySelector("p");

      results.push({
        firstMarginTop: firstP
          ? parseFloat(getComputedStyle(firstP).marginTop)
          : -1,
        lastMarginBottom: lastP
          ? parseFloat(getComputedStyle(lastP).marginBottom)
          : -1,
      });
    }
    return results;
  });

  // The reply's text segments are plain paragraphs — at least one renderer
  // should have <p> as its first and last block.
  const valid = firstLastMargins.filter(
    (r) => r.firstMarginTop >= 0 && r.lastMarginBottom >= 0,
  );
  expect(valid.length).toBeGreaterThan(0);
  for (const r of valid) {
    expect(r.firstMarginTop).toBe(0);
    expect(r.lastMarginBottom).toBe(0);
  }
});

test("assistant row flex gap is reduced", async ({ page }) => {
  // AC.5: .row.assistant flex gap is 5px (was 8px)
  await drive(page, "reply");
  await waitForSettledWorkBlocks(page, 2);

  const gap = await page.evaluate(() => {
    const row = document.querySelector(".row.assistant");
    if (!row) throw new Error("no .row.assistant found");
    return getComputedStyle(row).gap;
  });
  expect(gap).toBe("5px");
});
