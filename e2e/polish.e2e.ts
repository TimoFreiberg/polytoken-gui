import { expect, test } from "@playwright/test";
import {
  drive,
  expandWork,
  gotoFresh,
  openSidebar,
  waitForSettledWorkBlocks,
} from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("edit-tool card: collapsed +N/−M badge, expands to a @pierre/diffs render", async ({
  page,
}) => {
  await drive(page, "editdiff");
  const card = page.locator(".tool", { hasText: "Edit file" });
  await expect(card).toBeVisible();
  // Collapsed badge shows added/removed line counts (the edit changes one line).
  const counts = card.locator(".counts");
  await expect(counts).toContainText("+1");
  await expect(counts).toContainText("1");

  // The collapse/expand toggle carries a descriptive tooltip (title audit).
  await expect(card.locator(".head")).toHaveAttribute(
    "title",
    "Expand tool details",
  );

  // Expanding mounts the pierre diff into a shadow root (self-contained HTML).
  await card.locator(".head").click();
  await expect
    .poll(
      async () =>
        card.evaluate((el) =>
          [...el.querySelectorAll("*")].some((n) => !!n.shadowRoot),
        ),
      { timeout: 8000 },
    )
    .toBe(true);
});

test("message timestamps render with an exact-time tooltip", async ({
  page,
}) => {
  // The greeting already has user + assistant messages with timestamps.
  const times = page.locator("time.ts");
  await expect(times.first()).toBeVisible();
  await expect(times.first()).toHaveAttribute("title", /.+/);
  await expect(times.first()).toHaveAttribute("datetime", /.+/);
});

test("copy + timestamp show only on the turn-final paragraph", async ({
  page,
}) => {
  // The greeting turn has TWO assistant paragraphs (one before its tool call, one
  // after). Only the LAST carries the copy button + timestamp; the earlier one is bare.
  // The earlier paragraph lives inside the collapsed work block — reveal it first.
  await expandWork(page);
  const rows = page.locator(".row.assistant");
  await expect(rows).toHaveCount(2);
  const first = rows.first();
  const last = rows.last();
  await expect(first.getByRole("button", { name: "Copy message" })).toHaveCount(
    0,
  );
  await expect(first.locator("time.ts")).toHaveCount(0);
  await expect(
    last.getByRole("button", { name: "Copy message" }),
  ).toBeVisible();
  await expect(last.locator("time.ts")).toHaveCount(1);
});

test("an active turn's paragraph followed by a running tool stays bare", async ({
  page,
}) => {
  // Regression: while a turn is still in flight, a paragraph that LOOKS final (it
  // stopped streaming because a tool started after it) must NOT get the copy + timestamp
  // footer — more tools and text can still follow. staleidle leaves exactly that shape:
  // "On it …" paragraph, then a running tool, turn never completes.
  await drive(page, "staleidle");
  const active = page
    .locator(".row.assistant")
    .filter({ hasText: "kicking off a command" });
  await expect(active).toBeVisible();
  await expect(
    active.getByRole("button", { name: "Copy message" }),
  ).toHaveCount(0);
  await expect(active.locator("time.ts")).toHaveCount(0);
  // The PRIOR settled turn keeps its footer — the suppression is scoped to the live turn,
  // not a blanket "hide all footers while anything runs".
  const settled = page
    .locator(".row.assistant")
    .filter({ hasText: "Routes live in" });
  await expect(
    settled.getByRole("button", { name: "Copy message" }),
  ).toBeVisible();
});

test("copy button copies the whole turn's text and shows feedback", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const assistant = page.locator(".row.assistant").last();
  await assistant.hover();
  const copy = assistant.getByRole("button", { name: "Copy message" });
  await expect(copy).toBeVisible();
  await copy.click();
  // Feedback is now an icon swap (copy -> check) + accent tint, flagged by `copied`.
  await expect(copy).toHaveClass(/\bcopied\b/);
  // The clipboard holds BOTH paragraphs of the turn, not just the final block.
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("I'll add a lightweight health endpoint");
  expect(copied).toContain("Routes live in");
});

test("copy button fades back out once the pointer leaves the message", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  // gotoFresh returns mid-replay, while the greeting turn is still active. An active turn
  // keeps its "Worked for Ns" block expanded; runCompleted then collapses it, which yanks
  // the assistant row upward. hover() is one-shot — it parks the cursor at the row's
  // current centre — so a hover taken before that collapse is left stranded off the row,
  // `:hover` drops, and the copy button never animates to opacity 1. Wait for the work
  // block to collapse (aria-expanded="false" ⇒ turn settled, layout final) before hovering.
  await expect(page.getByTestId("work-toggle")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  const assistant = page.locator(".row.assistant").last();
  const copy = assistant.getByRole("button", { name: "Copy message" });
  // Hover reveals it (opacity animates to 1).
  await assistant.hover();
  await expect
    .poll(() => copy.evaluate((el) => getComputedStyle(el).opacity))
    .toBe("1");
  // Clicking copies but must not pin it visible via lingering :focus-visible;
  // leaving the row in any direction fades it back out.
  await copy.click();
  await page.mouse.move(0, 0);
  await expect
    .poll(() => copy.evaluate((el) => getComputedStyle(el).opacity))
    .toBe("0");
});

test("user prompt footer offers a copy button next to rewind; it copies the prompt", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const user = page.locator(".row.user").first();
  await user.hover();
  const copy = user.getByRole("button", { name: "Copy message" });
  const branch = user.getByRole("button", { name: "Rewind to this prompt" });
  await expect(copy).toBeVisible();
  await expect(branch).toBeVisible();
  // Copy sits to the LEFT of rewind in the footer (matches the assistant order).
  const copyBox = await copy.boundingBox();
  const branchBox = await branch.boundingBox();
  expect(copyBox).not.toBeNull();
  expect(branchBox).not.toBeNull();
  expect(copyBox!.x).toBeLessThan(branchBox!.x);

  await copy.click();
  await expect(copy).toHaveClass(/\bcopied\b/);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const promptText =
    (await user.locator(".bubble").textContent())?.trim() ?? "";
  expect(promptText.length).toBeGreaterThan(0);
  expect(copied).toBe(promptText);
});

test("no stray working indicator after a turn ends via sessionUpdated (not runCompleted)", async ({
  page,
}) => {
  await drive(page, "idle");
  // Wait for the streamed line to finish.
  await expect(
    page.getByText("ends with a status update", { exact: false }),
  ).toBeVisible();
  // The session is idle again — the bottom working indicator must be gone.
  await expect
    .poll(() => page.getByTestId("working-indicator").count())
    .toBe(0);
});

test("tab title mirrors the active session title", async ({ page }) => {
  // The greeting snapshot titles the session "Wire up the WebSocket bridge";
  // document.title should reflect it (suffixed with the app name) rather than
  // staying the static "pilot".
  await expect(page).toHaveTitle("Wire up the WebSocket bridge · pilot");
});

test("transcript: full markdown renders (headings, table, code, links)", async ({
  page,
}) => {
  await drive(page, "markdown");
  // Wait for the markdown turn to settle (final render) before asserting structure.
  const row = page.locator(".row.assistant").last();
  await expect(row.getByRole("button", { name: "Copy message" })).toBeVisible();
  const md = row.locator(".markstream-svelte.markdown-renderer");
  await expect(md.locator("h2")).toHaveText("Markdown showcase");
  await expect(md.locator("h3").first()).toHaveText("A table");
  await expect(md.locator("strong")).toHaveText("bold");
  await expect(md.locator("em")).toHaveText("italic");
  // GFM table — headers + a body cell.
  await expect(md.locator("table th").first()).toHaveText("Feature");
  await expect(md.locator("table td").first()).toHaveText("Headers");
  // Fenced code block renders as <pre> (renderCodeBlocksAsPre, no Monaco peer).
  await expect(md.locator("pre")).toContainText("function greet");
  // Links survive sanitization and are hardened with rel="noopener".
  const link = md.locator("a");
  await expect(link).toHaveAttribute("href", "https://example.com");
  await expect(link).toHaveAttribute("rel", /noopener/);
});

test("transcript: code blocks get a copy button that copies the code", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await drive(page, "markdown");
  const row = page.locator(".row.assistant").last();
  // The fenced code block is wrapped with a pinned copy button (top-right).
  const wrap = row.locator(".code-block", { has: page.locator("pre") });
  await expect(wrap).toBeVisible();
  const copy = wrap.getByRole("button", { name: "Copy code" });
  await expect(copy).toHaveCount(1);
  await copy.click();
  // Post-copy: the button flips to the "Copied" confirmation state.
  await expect(wrap.getByRole("button", { name: "Copied" })).toBeVisible();
  // The clipboard holds the code block's source (not the surrounding prose).
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain("function greet(name: string)");
  expect(clip).not.toContain("Markdown showcase");
});

test("type-to-focus: a printable key focuses the composer", async ({
  page,
}) => {
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur(),
  );
  await page.keyboard.press("h");
  await expect(page.locator(".composer-wrap textarea")).toBeFocused();
});

test("binary select renders a Yes/No card with the affirmative as primary", async ({
  page,
}) => {
  await drive(page, "yesno");
  const actions = page.locator('[role="dialog"] .actions.two button');
  await expect(actions).toHaveCount(2);
  // Affirmative ("Allow") is promoted to the primary button on the right,
  // even though it is second in the options array.
  await expect(actions.nth(0)).toHaveText("Don't allow");
  await expect(actions.nth(1)).toHaveText("Allow");
  await expect(actions.nth(1)).toHaveClass(/primary/);
});

test("timeout-bearing dialog shows a countdown and auto-resolves deny-safe", async ({
  page,
}) => {
  await drive(page, "timeout");
  await expect(page.getByText(/Auto-dismiss in \d+s/)).toBeVisible();
  // After the 3s timeout it auto-resolves to the deny-safe default.
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 8000 });
  await expect(page.getByText("Denied — skipping that step.")).toBeVisible();
});

test("Ctrl/Cmd+Up anchors to the scroll position, not always the last prompt", async ({
  page,
}) => {
  // Build enough turns that early prompts have room to scroll to the top of the viewport.
  for (let i = 0; i < 5; i++) {
    await drive(page, "reply");
    await expect(
      page.getByText("That confirms it", { exact: false }).last(),
    ).toBeVisible();
  }
  await waitForSettledWorkBlocks(page, 6);
  const count = await page.locator(".row.user").count();
  expect(count).toBeGreaterThanOrEqual(6);
  const last = count - 1;

  // Park user prompt #2 at the top of the viewport, well away from the live tail.
  await page.evaluate(() => {
    const sc = document.querySelector(".scroller") as HTMLElement;
    const row = document.querySelectorAll(".row.user")[2] as HTMLElement;
    sc.scrollTop +=
      row.getBoundingClientRect().top - sc.getBoundingClientRect().top;
  });
  // Confirm we're genuinely scrolled up off the tail before pressing the hotkey.
  const gap = () =>
    page.evaluate(() => {
      const sc = document.querySelector(".scroller") as HTMLElement;
      return sc.scrollHeight - sc.scrollTop - sc.clientHeight;
    });
  await expect.poll(gap).toBeGreaterThan(80);

  // Index of the `.row.user` whose top sits nearest the scroller's top.
  const topRowIndex = () =>
    page.evaluate(() => {
      const sc = document.querySelector(".scroller") as HTMLElement;
      const sTop = sc.getBoundingClientRect().top;
      let best = -1;
      let dist = Infinity;
      document.querySelectorAll(".row.user").forEach((r, i) => {
        const d = Math.abs(r.getBoundingClientRect().top - sTop);
        if (d < dist) {
          dist = d;
          best = i;
        }
      });
      return best;
    });

  // ⌘↑ jumps to the prompt at the top of where we're reading (#1, just above the parked
  // #2) — it does NOT yank down to the most recent prompt the way it used to.
  await page.keyboard.press("Control+ArrowUp");
  await expect.poll(topRowIndex).toBeLessThanOrEqual(2);
  const idx = await topRowIndex();
  expect(idx).toBeGreaterThanOrEqual(1); // moved up to an early prompt
  expect(idx).toBeLessThan(last); // and nowhere near the live tail
  expect(await gap()).toBeGreaterThan(80); // didn't scroll back to the bottom
});

test("Ctrl/Cmd+Up/Down step through user prompts", async ({ page }) => {
  // Build several turns so the oldest prompts have enough content below them to scroll to
  // the top (a short final turn can't, which is fine — the stepper clamps there).
  for (let i = 0; i < 5; i++) {
    await drive(page, "reply");
    await expect(
      page.getByText("That confirms it", { exact: false }).last(),
    ).toBeVisible();
  }
  await waitForSettledWorkBlocks(page, 6);

  const count = await page.locator(".row.user").count(); // greeting + 5 replies
  expect(count).toBeGreaterThanOrEqual(6);
  const last = count - 1;

  // True when the scroller sits at prompt `idx`'s block-start target. `scrollIntoView`
  // clamps at the max scroll offset, so a prompt too near the tail to reach the top
  // settles at the bottom — `min(within, max)` models that. (Asserting by scroll position,
  // not prompt text: the reply fixture reuses one prompt string across turns.)
  const atPrompt = (idx: number) =>
    page.evaluate((i) => {
      const sc = document.querySelector(".scroller") as HTMLElement;
      const row = document.querySelectorAll(".row.user")[i] as HTMLElement;
      const within =
        row.getBoundingClientRect().top -
        sc.getBoundingClientRect().top +
        sc.scrollTop;
      const max = sc.scrollHeight - sc.clientHeight;
      return Math.abs(sc.scrollTop - Math.min(within, max)) < 4;
    }, idx);
  const atBottom = () =>
    page.evaluate(() => {
      const sc = document.querySelector(".scroller") as HTMLElement;
      return sc.scrollHeight - sc.scrollTop - sc.clientHeight < 4;
    });

  // From the live tail, ⌘↑ walks one prompt older per press, all the way to the oldest.
  // Stepping one at a time (settling between presses) keeps each smooth scroll short.
  for (let i = last; i >= 0; i--) {
    await page.keyboard.press("Control+ArrowUp");
    await expect.poll(() => atPrompt(i)).toBe(true);
  }
  // Past the oldest, ⌘↑ clamps — it stays on the first prompt.
  await page.keyboard.press("Control+ArrowUp");
  await expect.poll(() => atPrompt(0)).toBe(true);

  // ⌘↓ walks back toward newer prompts…
  for (let i = 1; i <= last; i++) {
    await page.keyboard.press("Control+ArrowDown");
    await expect.poll(() => atPrompt(i)).toBe(true);
  }
  // …and stepping past the newest returns to the live bottom.
  await page.keyboard.press("Control+ArrowDown");
  await expect.poll(atBottom).toBe(true);
});

test("sending a prompt while scrolled up jumps the transcript to the bottom", async ({
  page,
}) => {
  // Build a transcript tall enough that its top and bottom differ.
  for (let i = 0; i < 3; i++) {
    await drive(page, "reply");
    await expect(
      page.getByText("That confirms it", { exact: false }).last(),
    ).toBeVisible();
  }
  await waitForSettledWorkBlocks(page, 4);

  // Scroll to the top so we're no longer pinned to the bottom.
  const scroller = page.locator(".scroller");
  await scroller.evaluate((el) => ((el as HTMLElement).scrollTop = 0));
  await expect
    .poll(() => scroller.evaluate((el) => (el as HTMLElement).scrollTop))
    .toBe(0);

  // Send a prompt from the composer.
  const box = page.getByPlaceholder("Message pilot…");
  await box.fill("jump to the bottom please");
  await box.press("Enter");

  // The new turn streams a reply; once it settles we should be pinned at the bottom —
  // the just-sent message + its reply pulled into view, not left below the fold.
  await waitForSettledWorkBlocks(page, 5);
  await expect
    .poll(() =>
      scroller.evaluate((el) => {
        const s = el as HTMLElement;
        return s.scrollHeight - s.scrollTop - s.clientHeight;
      }),
    )
    .toBeLessThan(80);
  // …and the "New messages ↓" catch-up pill never appeared (we followed the stream
  // down instead of falling behind it).
  await expect(page.getByTestId("new-messages-pill")).toHaveCount(0);
});

test("switching sessions restores the saved reading position", async ({
  page,
}) => {
  // Shrink the viewport so the short mock fixtures exceed the fold — only then is
  // "opened at the top" distinguishable from "opened at the bottom". Both the greeting
  // source and the target session scroll at this height.
  await page.setViewportSize({ width: 1100, height: 380 });

  const scroller = page.locator(".scroller");
  const top = () => scroller.evaluate((el) => (el as HTMLElement).scrollTop);
  const gap = () =>
    scroller.evaluate((el) => {
      const s = el as HTMLElement;
      return s.scrollHeight - s.scrollTop - s.clientHeight;
    });

  // Open a different session (taller than the fold) and scroll it PART-way up so it has a
  // saved reading position distinct from the bottom.
  await openSidebar(page);
  await page
    .getByTestId("sidebar")
    .getByText("Explore the fold reducer")
    .click();
  await expect(page.locator("header .title")).toContainText(
    "Explore the fold reducer",
  );
  await expect.poll(gap).toBeLessThan(80); // landed at the live bottom (no saved pos)
  // Scroll part-way up (not the very top, so the saved ratio is unambiguously mid-transcript)
  // and let the debounced save fire. The fixture is short, so target a clear mid-point and
  // assert relative to IT, not an absolute px threshold.
  const targetTop = await scroller.evaluate((el) => {
    const s = el as HTMLElement;
    const t = Math.floor((s.scrollHeight - s.clientHeight) * 0.5);
    s.scrollTo({ top: t });
    return t;
  });
  await expect.poll(top).toBe(targetTop);
  await expect.poll(gap).toBeGreaterThan(40); // genuinely scrolled up off the bottom
  // Wait for the debounced persist (200ms) to land in localStorage.
  await page.waitForTimeout(350);
  const savedTop = await top();

  // Switch to the greeting (a DIFFERENT session), then back. The restored session should
  // land near where we left it, NOT at the live bottom. (We don't assert the greeting's
  // own position — it may restore to ITS saved spot or the bottom; either is fine. We
  // only care that older-session, when we return to it, lands at its saved reading spot.)
  await openSidebar(page);
  await page.getByTestId("sidebar").getByText("Wire up the WebSocket").click();
  await expect(page.locator("header .title")).toContainText(
    "Wire up the WebSocket",
  );
  await openSidebar(page);
  await page
    .getByTestId("sidebar")
    .getByText("Explore the fold reducer")
    .click();
  // Restored to the saved reading position (within a tolerance — the ratio is re-derived
  // against the current scrollHeight, which may differ slightly from the saved height).
  await expect.poll(top).toBeGreaterThan(targetTop - 30);
  const restoredTop = await top();
  expect(Math.abs(restoredTop - savedTop)).toBeLessThan(30);
  // …and NOT at the live bottom (gap is meaningfully large, no pill).
  await expect.poll(gap).toBeGreaterThan(40);
  await expect(page.getByTestId("new-messages-pill")).toHaveCount(0);
});

test("a session with no saved position still lands at the live bottom", async ({
  page,
}) => {
  // Companion to the restore test: a session you've never scrolled (or whose position was
  // cleared) opens at the live tail, not a stale/carried-over spot.
  await page.setViewportSize({ width: 1100, height: 380 });

  const scroller = page.locator(".scroller");
  const top = () => scroller.evaluate((el) => (el as HTMLElement).scrollTop);
  const gap = () =>
    scroller.evaluate((el) => {
      const s = el as HTMLElement;
      return s.scrollHeight - s.scrollTop - s.clientHeight;
    });

  // Leave the greeting scrolled to the very top, then switch to a different session that
  // has no saved position — it should open at the live bottom, not the carried-over top.
  await scroller.evaluate((el) => ((el as HTMLElement).scrollTop = 0));
  await expect.poll(top).toBe(0);
  await expect.poll(gap).toBeGreaterThan(80);
  await openSidebar(page);
  await page
    .getByTestId("sidebar")
    .getByText("Explore the fold reducer")
    .click();
  await expect(page.locator("header .title")).toContainText(
    "Explore the fold reducer",
  );
  await expect.poll(top).toBeGreaterThan(80);
  await expect.poll(gap).toBeLessThan(80);
  await expect(page.getByTestId("new-messages-pill")).toHaveCount(0);
});

test("switching away does not corrupt the leaving session's saved position", async ({
  page,
}) => {
  // Regression guard for the root save bug: the switch-away save used to run in a
  // post-DOM-patch $effect, by which point the scroller already showed the INCOMING
  // session — so it overwrote the leaving session's ratio with the new session's geometry.
  // Here we record the saved ratio BEFORE the switch and assert it is untouched AFTER.
  await page.setViewportSize({ width: 1100, height: 380 });
  const scroller = page.locator(".scroller");
  const top = () => scroller.evaluate((el) => (el as HTMLElement).scrollTop);
  const gap = () =>
    scroller.evaluate((el) => {
      const s = el as HTMLElement;
      return s.scrollHeight - s.scrollTop - s.clientHeight;
    });
  const savedRatio = (id: string) =>
    page.evaluate((sid) => {
      const raw = localStorage.getItem("pilot.scrollPositions");
      return raw ? (JSON.parse(raw)[sid]?.ratio ?? null) : null;
    }, id);

  // Open older-session and scroll it to a clear mid-transcript spot; let the debounce land.
  await openSidebar(page);
  await page
    .getByTestId("sidebar")
    .getByText("Explore the fold reducer")
    .click();
  await expect(page.locator("header .title")).toContainText(
    "Explore the fold reducer",
  );
  await expect.poll(gap).toBeLessThan(80); // wait for the open to land before scrolling
  await page.waitForTimeout(550); // let the open's settle/save-suppression window lapse
  const targetTop = await scroller.evaluate((el) => {
    const s = el as HTMLElement;
    const t = Math.floor((s.scrollHeight - s.clientHeight) * 0.5);
    s.scrollTo({ top: t });
    return t;
  });
  await expect.poll(top).toBe(targetTop);
  await page.waitForTimeout(350); // debounced persist (200ms) + margin
  const before = await savedRatio("older-session");
  expect(before).not.toBeNull();

  // Switch to a DIFFERENT session. The leaving session's saved ratio must be unchanged —
  // the switch must not re-save it against the incoming transcript's geometry.
  await openSidebar(page);
  await page.getByTestId("sidebar").getByText("Wire up the WebSocket").click();
  await expect(page.locator("header .title")).toContainText(
    "Wire up the WebSocket",
  );
  const after = await savedRatio("older-session");
  expect(after).not.toBeNull();
  expect(Math.abs((after as number) - (before as number))).toBeLessThan(0.01);
});

test("a session left at the live tail returns to the tail on focus", async ({
  page,
}) => {
  // Factor 3 (owner's call): if you were at the END when you switched away, you come back
  // to the END — not a stale proportional spot. The position is saved with an explicit
  // `atBottom` flag (NOT inferable from the ratio once content grows), and restore chases
  // the live tail for it.
  await page.setViewportSize({ width: 1100, height: 380 });
  const scroller = page.locator(".scroller");
  const top = () => scroller.evaluate((el) => (el as HTMLElement).scrollTop);
  const gap = () =>
    scroller.evaluate((el) => {
      const s = el as HTMLElement;
      return s.scrollHeight - s.scrollTop - s.clientHeight;
    });

  // Open older-session, then deliberately scroll up and back to the bottom so a REAL scroll
  // event (not the open's programmatic snap) persists an at-bottom position.
  await openSidebar(page);
  await page
    .getByTestId("sidebar")
    .getByText("Explore the fold reducer")
    .click();
  await expect(page.locator("header .title")).toContainText(
    "Explore the fold reducer",
  );
  await expect.poll(gap).toBeLessThan(80); // wait for the open to land before scrolling
  await page.waitForTimeout(900); // let the open's settle/progScrollUntil window lapse
  await scroller.evaluate((el) => ((el as HTMLElement).scrollTop = 0));
  await expect.poll(top).toBe(0);
  await page.waitForTimeout(300); // debounced persist of the scrolled-up spot
  await scroller.evaluate(
    (el) => ((el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight),
  );
  await expect.poll(gap).toBeLessThan(80);
  await page.waitForTimeout(350); // debounced persist
  const atBottom = await page.evaluate(() => {
    const raw = localStorage.getItem("pilot.scrollPositions");
    return raw ? JSON.parse(raw)["older-session"]?.atBottom : undefined;
  });
  expect(atBottom).toBe(true);

  // Switch away and back — we should land at the live tail, not the mid-transcript ratio.
  await openSidebar(page);
  await page.getByTestId("sidebar").getByText("Wire up the WebSocket").click();
  await expect(page.locator("header .title")).toContainText(
    "Wire up the WebSocket",
  );
  await openSidebar(page);
  await page
    .getByTestId("sidebar")
    .getByText("Explore the fold reducer")
    .click();
  await expect(page.locator("header .title")).toContainText(
    "Explore the fold reducer",
  );
  await expect.poll(gap).toBeLessThan(80); // back at the live tail
  await expect(page.getByTestId("new-messages-pill")).toHaveCount(0);
});

test("PWA update prompt appears and can be dismissed", async ({ page }) => {
  // The ?dev bar's "update" button stands in for a real service-worker update.
  await page.getByRole("button", { name: "update", exact: true }).click();
  const toast = page.getByText("A new version of pilot is available");
  await expect(toast).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Dismiss update" }).click();
  await expect(toast).toBeHidden();
});
