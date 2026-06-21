import { expect, test, type Page } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

// Runs under the "mobile" project (Pixel 7, hasTouch). Pull-to-refresh is touch-only —
// the universal mobile "I think this is stale" gesture; desktop has Reconnect (Alt+R).

/** Dispatch a synthetic top-edge pull on a scroll container. Force scrollTop=0 first (the
 *  transcript can be pinned to the bottom) so the gesture engages, then fire touchstart →
 *  a downward touchmove → touchend, all cancelable. `dy` is raw finger travel in px;
 *  the post-resistance indicator distance is ≈ dy * 0.5 (arm threshold is 64px). */
async function pullDown(
  page: Page,
  selector: string,
  dy: number,
): Promise<void> {
  await page.evaluate(
    ({ selector, dy }) => {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (!el) throw new Error(`pullDown: no element for ${selector}`);
      el.scrollTop = 0;
      const startY = 12;
      const touch = (clientY: number) =>
        new Touch({ identifier: 1, target: el, clientX: 24, clientY });
      const fire = (type: string, clientY: number, moving: boolean) =>
        el.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: moving ? [touch(clientY)] : [],
            changedTouches: [touch(clientY)],
          }),
        );
      fire("touchstart", startY, true);
      fire("touchmove", startY + dy * 0.5, true);
      fire("touchmove", startY + dy, true);
      fire("touchend", startY + dy, false);
    },
    { selector, dy },
  );
}

const offline = (page: Page) =>
  page.getByText("the agent keeps running", { exact: false });

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("pulling the transcript down forces a reconnect + re-snapshot", async ({
  page,
}) => {
  // Drop the transport without taking Vite offline (same hook the delivery specs use);
  // the offline banner is our connected/offline probe.
  await page.evaluate(() =>
    window.dispatchEvent(new Event("pilot:test-disconnect")),
  );
  await expect(offline(page)).toBeVisible();

  await pullDown(page, ".scroller", 220); // ~110px → past the 64px threshold

  // The refreshing spinner shows on the transcript surface...
  await expect(page.getByTestId("ptr-transcript")).toHaveAttribute(
    "data-phase",
    "refreshing",
  );
  // ...and the socket comes back: the offline banner clears.
  await expect(offline(page)).toBeHidden();
  // The spinner settles once reconnected (min-visible floor, then clears).
  await expect(page.getByTestId("ptr-transcript")).toBeHidden({
    timeout: 5000,
  });
});

test("a pull short of the threshold does not reconnect", async ({ page }) => {
  await page.evaluate(() =>
    window.dispatchEvent(new Event("pilot:test-disconnect")),
  );
  await expect(offline(page)).toBeVisible();

  await pullDown(page, ".scroller", 60); // ~30px → below the threshold

  // No refresh fired: indicator stays hidden and we're still offline.
  await expect(page.getByTestId("ptr-transcript")).toBeHidden();
  await expect(offline(page)).toBeVisible();
});
