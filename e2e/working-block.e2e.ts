import { expect, test } from "@playwright/test";
import { drive, expandWork, gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("a settled turn collapses its working section behind 'Worked for Ns'", async ({
  page,
}) => {
  const toggle = page.getByTestId("work-toggle");
  // The header carries the turn's wall-clock duration (the greeting's mock turn is ~37s).
  await expect(toggle).toHaveText(/Worked for 37s/);

  // Collapsed by default: the work body isn't rendered, so neither narration nor tool show…
  await expect(page.getByTestId("work-body")).toHaveCount(0);
  await expect(
    page.getByText("I'll add a lightweight health endpoint"),
  ).toHaveCount(0);
  await expect(page.getByText("Run shell command")).toHaveCount(0);
  // …but the turn-final answer stays visible.
  await expect(page.getByText("Routes live in")).toBeVisible();
});

test("the collapse affordance never appears while the final response is still streaming", async ({
  page,
}) => {
  await page.evaluate(() => {
    const probe = {
      sawLiveToggle: false,
      observer: null as MutationObserver | null,
    };
    const scan = () => {
      if (
        [...document.querySelectorAll('[data-testid="work-toggle"]')].some(
          (el) => el.textContent?.includes("Working…"),
        )
      ) {
        probe.sawLiveToggle = true;
      }
    };
    probe.observer = new MutationObserver(scan);
    probe.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    (
      window as Window & {
        __pilotCollapseProbe?: typeof probe;
      }
    ).__pilotCollapseProbe = probe;
    scan();
  });

  await drive(page, "reply");
  await expect(
    page.getByText("That confirms it", { exact: false }),
  ).toBeVisible();
  await expect
    .poll(() => page.getByTestId("working-indicator").count())
    .toBe(0);

  const sawLiveToggle = await page.evaluate(() => {
    const probe = (
      window as Window & {
        __pilotCollapseProbe?: {
          sawLiveToggle: boolean;
          observer: MutationObserver | null;
        };
      }
    ).__pilotCollapseProbe;
    probe?.observer?.disconnect();
    return probe?.sawLiveToggle ?? false;
  });
  expect(sawLiveToggle).toBe(false);
  await expect(page.getByTestId("work-toggle")).toHaveCount(2);
});

test("the working block toggles open and closed, with a descriptive tooltip", async ({
  page,
}) => {
  const toggle = page.getByTestId("work-toggle");

  // Collapsed → tooltip invites expansion.
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toHaveAttribute(
    "title",
    /Expand the agent's working steps/,
  );

  // Expand: the work body mounts; the narration + one-tool summary appear.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveAttribute(
    "title",
    /Collapse the agent's working steps/,
  );
  await expect(page.getByTestId("work-body")).toBeVisible();
  await expect(
    page.getByText("I'll add a lightweight health endpoint"),
  ).toBeVisible();
  const summary = page.locator(".tool.summary");
  await expect(summary.locator(":scope > .head .name")).toHaveText("1 tool");
  await expect(summary.locator(":scope > .head .arg")).toHaveText("bash");

  // Collapse again: the body unmounts.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("work-body")).toHaveCount(0);
});

test("each turn's working block collapses independently", async ({ page }) => {
  // Drive a second turn (the reply script) on top of the greeting. Both settle, so both
  // collapse — two independent "Worked for Ns" headers.
  await drive(page, "reply");
  await expect(
    page.getByText("That confirms it", { exact: false }),
  ).toBeVisible();

  const toggles = page.getByTestId("work-toggle");
  await expect(toggles).toHaveCount(2);

  // Expanding the latest turn's block doesn't open the greeting's.
  await expandWork(page, "last");
  await expect(toggles.last()).toHaveAttribute("aria-expanded", "true");
  await expect(toggles.first()).toHaveAttribute("aria-expanded", "false");
  // The greeting's narration stays hidden; the reply's is revealed.
  await expect(
    page.getByText("I'll add a lightweight health endpoint"),
  ).toHaveCount(0);
  await expect(
    page.getByText("Here's the plan", { exact: false }),
  ).toBeVisible();
});
