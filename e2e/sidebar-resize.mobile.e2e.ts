import { expect, test } from "@playwright/test";
import { gotoFresh, openRightSidebar, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("pantoken.sidebarWidth", "600");
    localStorage.setItem("pantoken.rightSidebarWidth", "500");
  });
  await gotoFresh(page);
});

test("mobile views ignore desktop widths and have no resize handle", async ({
  page,
}) => {
  await openSidebar(page);
  await openRightSidebar(page);
  await expect(page.getByRole("separator")).toHaveCount(0);
  await expect(page.getByTestId("sidebar")).toHaveCSS("width", /px$/);
  await expect(page.getByTestId("right-sidebar")).toHaveCSS("width", /px$/);
  // Sessions and Context are full-screen phone views; persisted desktop widths do
  // not affect either surface.
  expect(
    Math.round(
      await page
        .getByTestId("sidebar")
        .evaluate((el) => el.getBoundingClientRect().width),
    ),
  ).toBe(page.viewportSize()!.width);
  // The context panel is a FULL-SCREEN view on phone (docs/PLAN-mobile.md D2) —
  // the persisted 500px desktop width must not leak into it either way.
  // Rounded: device-pixel scaling makes getBoundingClientRect subpixel (411.9999…).
  expect(
    Math.round(
      await page
        .getByTestId("right-sidebar")
        .evaluate((el) => el.getBoundingClientRect().width),
    ),
  ).toBe(page.viewportSize()!.width);
  await expect
    .poll(() =>
      page.evaluate(() => ({
        left: localStorage.getItem("pantoken.sidebarWidth"),
        right: localStorage.getItem("pantoken.rightSidebarWidth"),
      })),
    )
    .toEqual({ left: "600", right: "500" });
});
