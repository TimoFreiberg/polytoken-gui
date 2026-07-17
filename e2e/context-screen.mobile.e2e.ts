import { expect, test } from "@playwright/test";
import {
  drive,
  gotoFresh,
  openRightSidebar,
  openSidebar,
} from "./helpers.js";

// The phone context experience (docs/PLAN-mobile.md D2/D3): the right panel is a
// FULL-SCREEN view opened from a badged header entry, and overlays participate in
// browser history so the OS back gesture closes them instead of leaving the app
// (lib/overlay-history.ts). Runs under the "mobile" project (Pixel 7).

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("the header context entry shows a plain-total badge", async ({ page }) => {
  // Default fixture: no flags/jobs/todos → the header entry is still visible
  // (always reachable) but carries no badge.
  const entry = page.getByTestId("context-open");
  await expect(entry).toBeVisible();
  await expect(entry.getByTestId("context-badge")).toHaveCount(0);
  // The sidebar Context button no longer exists — the entry moved to the header.
  await openSidebar(page);
  await expect(page.getByTestId("sidebar-context")).toHaveCount(0);
  await page.getByRole("button", { name: "Close sessions" }).click();

  // The context fixture: 3 flagged files + 3 jobs + 3 todos = 9, plain totals
  // (no unseen/unread semantics — D3).
  await drive(page, "context");
  await expect(page.getByTestId("context-open")).toBeVisible();
  await expect(page.getByTestId("context-badge")).toHaveText("9");
});

test("the context view opens full-screen with a title and back arrow", async ({
  page,
}) => {
  await openRightSidebar(page);
  const panel = page.getByTestId("right-sidebar");
  await expect(panel).toHaveAttribute("data-open", "true");

  // Full-screen: the panel covers the viewport (not a 320px drawer). Polled —
  // the view slides in over 0.22s, so an immediate boundingBox can catch it
  // mid-transform.
  const viewport = page.viewportSize()!;
  await expect
    .poll(async () => {
      const box = await panel.boundingBox();
      return box && { w: Math.round(box.width), h: Math.round(box.height) };
    })
    .toEqual({ w: viewport.width, h: viewport.height });

  // Full-screen views carry a name + a back affordance.
  await expect(panel.getByText("Context")).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Collapse context panel" }),
  ).toBeVisible();
});

test("the browser back gesture closes the context view without leaving the app", async ({
  page,
}) => {
  const url = page.url();
  await openRightSidebar(page);
  const panel = page.getByTestId("right-sidebar");
  await expect(panel).toHaveAttribute("data-open", "true");

  await page.goBack();
  await expect(panel).toHaveAttribute("data-open", "false");
  // Still on the app, same document — back closed the overlay, not the page.
  expect(page.url()).toBe(url);
  await expect(page.getByTestId("work-toggle")).toBeVisible();
});

test("the browser back gesture closes the sessions drawer", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");
  await expect(sidebar).toHaveAttribute("data-open", "true");

  await page.goBack();
  await expect(sidebar).toHaveAttribute("data-open", "false");
  await expect(page.getByTestId("work-toggle")).toBeVisible();
});

test("a UI close consumes the history entry so back still works cleanly after", async ({
  page,
}) => {
  const panel = page.getByTestId("right-sidebar");

  // Open → close via the back arrow (a UI close, not a history pop).
  await openRightSidebar(page);
  await expect(panel).toHaveAttribute("data-open", "true");
  await panel.getByRole("button", { name: "Collapse context panel" }).click();
  await expect(panel).toHaveAttribute("data-open", "false");

  // Open again → the back gesture must close THIS open, first try (no stale
  // entry from the previous open/close cycle in between).
  await openRightSidebar(page);
  await expect(panel).toHaveAttribute("data-open", "true");
  await page.goBack();
  await expect(panel).toHaveAttribute("data-open", "false");
  await expect(page.getByTestId("work-toggle")).toBeVisible();
});

test("a phone cold load never restores a persisted-open panel", async ({
  page,
}) => {
  // A desktop visit persists "open" — the phone must ignore it (overlays are
  // transient; a cold load with the transcript covered reads as broken).
  await page.addInitScript(() => {
    localStorage.setItem("pantoken.rightSidebarOpen", "1");
    localStorage.setItem("pantoken.sidebarOpen", "1");
  });
  await gotoFresh(page);
  await expect(page.getByTestId("right-sidebar")).toHaveAttribute(
    "data-open",
    "false",
  );
  await expect(page.getByTestId("sidebar")).toHaveAttribute(
    "data-open",
    "false",
  );
});

test("phone navigation does not clobber the desktop context preference", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("pantoken.rightSidebarPreference", "auto");
  });
  await gotoFresh(page);
  // Open + close the context view on the phone…
  await openRightSidebar(page);
  await page
    .getByTestId("right-sidebar")
    .getByRole("button", { name: "Collapse context panel" })
    .click();
  // …and the desktop preference is untouched.
  const stored = await page.evaluate(() =>
    localStorage.getItem("pantoken.rightSidebarPreference"),
  );
  expect(stored).toBe("auto");
});

test("sessions and context are mutually exclusive and Back returns to transcript", async ({
  page,
}) => {
  await openRightSidebar(page);
  await expect(page.getByTestId("right-sidebar")).toHaveAttribute(
    "data-open",
    "true",
  );

  // The hotkey remains available even though the full-screen context view covers
  // the header, and switches rather than stacking the two mobile views.
  await page.keyboard.press("Control+b");
  await expect(page.getByTestId("right-sidebar")).toHaveAttribute(
    "data-open",
    "false",
  );
  await expect(page.getByTestId("sidebar")).toHaveAttribute(
    "data-open",
    "true",
  );

  await page.goBack();
  await expect(page.getByTestId("sidebar")).toHaveAttribute(
    "data-open",
    "false",
  );
  await expect(page.getByTestId("work-toggle")).toBeVisible();
});

test("mobile focus survives a desktop breakpoint round trip", async ({
  page,
}) => {
  await openRightSidebar(page);
  await expect(page.getByTestId("right-sidebar")).toHaveAttribute(
    "data-open",
    "true",
  );

  await page.setViewportSize({ width: 1280, height: 850 });
  await expect(page.getByTestId("sidebar")).toHaveAttribute(
    "data-open",
    "true",
  );
  await expect(page.getByTestId("right-sidebar")).toHaveAttribute(
    "data-open",
    "true",
  );

  await page.setViewportSize({ width: 412, height: 915 });
  await expect(page.getByTestId("sidebar")).toHaveAttribute(
    "data-open",
    "false",
  );
  await expect(page.getByTestId("right-sidebar")).toHaveAttribute(
    "data-open",
    "true",
  );
});
