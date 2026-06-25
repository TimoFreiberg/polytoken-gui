import { expect, test, type Page } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

// Runs under the "mobile" project (Pixel 7, hasTouch). The left-edge swipe is touch-only
// — the universal mobile "open the drawer" gesture; desktop opens via ⌘B / the header
// hamburger. The swipe surface is the main pane (.app); the phone drawer slides in from
// off-screen, so we assert on `data-open` rather than visibility (the drawer stays mounted).

/** Dispatch a synthetic left-edge swipe on a surface. A touch begins inside the 24px edge
 *  strip, then drags rightward, then lifts. `dx` is raw finger travel in px; the post-
 *  resistance follow distance equals dx (resistance 1), and the arm threshold is 88px. */
async function swipeFromLeftEdge(
  page: Page,
  selector: string,
  dx: number,
): Promise<void> {
  await page.evaluate(
    ({ selector, dx }) => {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (!el) throw new Error(`swipeFromLeftEdge: no element for ${selector}`);
      const startX = 12; // inside the 24px edge strip
      const touch = (clientX: number) =>
        new Touch({ identifier: 1, target: el, clientX, clientY: 200 });
      const fire = (type: string, clientX: number, moving: boolean) =>
        el.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: moving ? [touch(clientX)] : [],
            changedTouches: [touch(clientX)],
          }),
        );
      fire("touchstart", startX, true);
      fire("touchmove", startX + dx * 0.5, true);
      fire("touchmove", startX + dx, true);
      fire("touchend", startX + dx, false);
    },
    { selector, dx },
  );
}

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("swiping in from the left edge opens the drawer", async ({ page }) => {
  const sidebar = page.getByTestId("sidebar");
  await expect(sidebar).toHaveAttribute("data-open", "false");

  await swipeFromLeftEdge(page, ".app", 160); // 160px → past the 88px threshold

  await expect(sidebar).toHaveAttribute("data-open", "true");
});

test("a swipe short of the threshold does not open the drawer", async ({
  page,
}) => {
  const sidebar = page.getByTestId("sidebar");
  await expect(sidebar).toHaveAttribute("data-open", "false");

  await swipeFromLeftEdge(page, ".app", 50); // 50px → below the 88px threshold

  // No open fired: the drawer stays closed.
  await expect(sidebar).toHaveAttribute("data-open", "false");
});

test("a touch starting outside the edge strip does not open the drawer", async ({
  page,
}) => {
  const sidebar = page.getByTestId("sidebar");
  await expect(sidebar).toHaveAttribute("data-open", "false");

  // Begin the touch well past the 24px edge strip, then drag rightward across the screen.
  await page.evaluate(() => {
    const el = document.querySelector(".app") as HTMLElement;
    const startX = 120; // outside the edge strip
    const touch = (clientX: number) =>
      new Touch({ identifier: 1, target: el, clientX, clientY: 200 });
    const fire = (type: string, clientX: number, moving: boolean) =>
      el.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: moving ? [touch(clientX)] : [],
          changedTouches: [touch(clientX)],
        }),
      );
    fire("touchstart", startX, true);
    fire("touchmove", startX + 80, true);
    fire("touchmove", startX + 160, true);
    fire("touchend", startX + 160, false);
  });

  await expect(sidebar).toHaveAttribute("data-open", "false");
});
