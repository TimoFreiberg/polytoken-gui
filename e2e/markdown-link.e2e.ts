import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

// Regression for the desktop-app bug where a markdown link's hover tooltip stuck
// around forever and intercepted clicks. Root cause: markstream-svelte's built-in
// link tooltip (`.ms-tooltip`, via its singletonTooltip) is styled entirely by the
// renderer's base dist/index.css, which pantoken deliberately does NOT import (we theme
// via markstream-theme.css). Without that CSS the singleton has no opacity binding
// (hideTooltip only flips data-visible) and no `pointer-events:none`, so it rendered
// as unstyled plain text that never hid and, at z-index 9999, ate clicks on links
// beneath it. The fix passes showTooltips={false} to MarkdownRender, which (a) stops
// markstream from ever creating `.ms-tooltip` and (b) makes LinkNode emit a plain
// `title={href}` that pantoken's single delegated Tooltip.svelte renders instead.
test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("markdown links route through pantoken's tooltip, not markstream's stuck one", async ({
  page,
}) => {
  await drive(page, "markdown");

  // The showcase fixture renders `[link](https://example.com)`.
  const link = page.locator("a.link-node", { hasText: "link" }).first();
  await expect(link).toBeVisible();

  // markstream's own tooltip is off, so LinkNode falls back to a plain `title`
  // attribute — the hook our delegated Tooltip.svelte reads. (It carries the href,
  // since the markdown link has no explicit title.)
  await expect(link).toHaveAttribute("title", "https://example.com");
  await expect(link).toHaveAttribute("href", "https://example.com");

  // The broken singleton must never be created — not before and not after a hover.
  // Its absence is what kills both the stuck-forever text and the click-eating overlay.
  await expect(page.locator(".ms-tooltip")).toHaveCount(0);
  await link.hover();
  await page.waitForTimeout(200); // past markstream's 80ms show timer, had it fired
  await expect(page.locator(".ms-tooltip")).toHaveCount(0);
});
