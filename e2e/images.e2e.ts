import { expect, type Page, test } from "@playwright/test";
import { drive, gotoFresh, waitForSettledWorkBlocks } from "./helpers.js";

/** Read the current bottom gap (scrollHeight - scrollTop - clientHeight). */
function gapFn(scroller: import("@playwright/test").Locator) {
  return scroller.evaluate(
    (el) =>
      (el as HTMLElement).scrollHeight -
      (el as HTMLElement).scrollTop -
      (el as HTMLElement).clientHeight,
  );
}

/** Assert the scroller is pinned at the live bottom (gap ≈ 0) and the final
 *  assistant row is entirely above the composer (no clipping). */
async function assertPinnedToBottom(
  page: import("@playwright/test").Page,
): Promise<void> {
  const scroller = page.locator(".scroller");
  // Near-zero bottom gap — the ResizeObserver keeps us at the exact bottom.
  await expect.poll(() => gapFn(scroller), { timeout: 5000 }).toBeLessThan(4);
  // The final assistant row's bottom edge is above the composer's top edge.
  const clearance = await page.evaluate(() => {
    const rows = document.querySelectorAll(".row.assistant");
    const lastRow = rows[rows.length - 1];
    const composer = document.querySelector(".composer-wrap");
    if (!lastRow || !composer) return -1;
    return (
      composer.getBoundingClientRect().top -
      lastRow.getBoundingClientRect().bottom
    );
  });
  expect(clearance).toBeGreaterThan(0);
}

/** Disable overflow-anchor (simulating iOS Safari), wait for the settle window
 *  to lapse, then insert a small spacer BEFORE the final assistant row —
 *  mimicking a late image decode in a row above the final text that grows the
 *  content height and pushes the final row down. Appending at the END would grow
 *  scrollHeight (opening a gap) but wouldn't move the final row, so the
 *  clearance check wouldn't be discriminative. Inserting before the final row
 *  pushes it down, matching the real bug: images decode in rows ABOVE the final
 *  assistant text, pushing it below the viewport. */
async function forceLateHeightChange(
  page: import("@playwright/test").Page,
  px: number,
): Promise<void> {
  const scroller = page.locator(".scroller");
  await scroller.evaluate((el) => {
    (el as HTMLElement).style.overflowAnchor = "none";
  });
  // Wait for the 500ms settle window to lapse (plus margin).
  await page.waitForTimeout(1500);
  await scroller.locator(".col").evaluate((el, height) => {
    const rows = el.querySelectorAll(".row.assistant");
    const lastRow = rows[rows.length - 1];
    if (!lastRow) return;
    const spacer = document.createElement("div");
    spacer.id = "test-late-decode";
    spacer.style.height = `${height}px`;
    lastRow.parentNode!.insertBefore(spacer, lastRow);
  }, px);
}

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=";

async function dispatchFiles(
  page: Page,
  kind: "paste" | "dragenter" | "drop",
  files: { name: string; type: string; base64: string }[],
): Promise<void> {
  await page.evaluate(
    ({ kind, files }) => {
      const transfer = new DataTransfer();
      for (const item of files) {
        const bytes = Uint8Array.from(atob(item.base64), (char) =>
          char.charCodeAt(0),
        );
        transfer.items.add(new File([bytes], item.name, { type: item.type }));
      }
      if (kind === "paste") {
        document.querySelector("textarea")?.dispatchEvent(
          new ClipboardEvent("paste", {
            clipboardData: transfer,
            bubbles: true,
            cancelable: true,
          }),
        );
      } else {
        document.querySelector(".composer-wrap")?.dispatchEvent(
          new DragEvent(kind, {
            dataTransfer: transfer,
            bubbles: true,
            cancelable: true,
          }),
        );
      }
    },
    { kind, files },
  );
}

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("pasting a screenshot attaches it and image-only send stays visible", async ({
  page,
}) => {
  await dispatchFiles(page, "paste", [
    { name: "screenshot.png", type: "image/png", base64: PNG },
  ]);

  await expect(page.locator(".thumb-chip img")).toHaveCount(1);
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByTestId("sent-image")).toBeVisible();
  // Regression: the outbox persists each prompt to IndexedDB, which refuses to clone
  // Svelte `$state` proxies. Image-bearing prompts must reach the outbox as plain data;
  // a proxy leak surfaces a "couldn't update the prompt outbox" banner here (delivery
  // still happens, so the image above shows up either way — assert the banner is absent).
  await expect(page.getByText("prompt outbox")).toHaveCount(0);
});

test("a thumbnail opens a full-screen preview that walks the batch and dismisses", async ({
  page,
}) => {
  await dispatchFiles(page, "paste", [
    { name: "a.png", type: "image/png", base64: PNG },
    { name: "b.png", type: "image/png", base64: PNG },
  ]);
  await expect(page.locator(".thumb-chip img")).toHaveCount(2);

  // Click a thumbnail's image (not its × badge) to enlarge it.
  await page.locator(".thumb-chip").first().locator(".thumb-preview").click();
  const lightbox = page.getByTestId("image-lightbox");
  await expect(lightbox).toBeVisible();
  await expect(lightbox.locator(".counter")).toHaveText("1 / 2");

  // → / next button advances; the counter follows.
  await lightbox.getByRole("button", { name: "Next image" }).click();
  await expect(lightbox.locator(".counter")).toHaveText("2 / 2");

  // Escape dismisses and returns focus to the composer.
  await page.keyboard.press("Escape");
  await expect(lightbox).toHaveCount(0);
  await expect(page.locator("textarea")).toBeFocused();
});

test("the × badge removes a single attachment without sending", async ({
  page,
}) => {
  await dispatchFiles(page, "paste", [
    { name: "a.png", type: "image/png", base64: PNG },
    { name: "b.png", type: "image/png", base64: PNG },
  ]);
  await expect(page.locator(".thumb-chip img")).toHaveCount(2);

  await page
    .locator(".thumb-chip")
    .first()
    .getByRole("button", { name: /Remove attachment/ })
    .click();
  await expect(page.locator(".thumb-chip img")).toHaveCount(1);
  // Removing an attachment must not open the preview.
  await expect(page.getByTestId("image-lightbox")).toHaveCount(0);
});

test("drag/drop shows a target and visibly rejects unsupported files", async ({
  page,
}) => {
  const text = btoa("not an image");
  await dispatchFiles(page, "dragenter", [
    { name: "notes.txt", type: "text/plain", base64: text },
  ]);
  await expect(page.getByTestId("image-drop-overlay")).toBeVisible();
  await dispatchFiles(page, "drop", [
    { name: "notes.txt", type: "text/plain", base64: text },
  ]);
  await expect(page.getByTestId("image-drop-overlay")).toHaveCount(0);
  await expect(page.getByTestId("attachment-status")).toContainText(
    "unsupported image type",
  );

  await dispatchFiles(page, "drop", [
    { name: "drop.png", type: "image/png", base64: PNG },
  ]);
  await expect(page.locator(".thumb-chip img")).toHaveCount(1);
  await expect(page.getByTestId("attachment-status")).toHaveCount(0);
});

test("the attachment count limit is enforced before reading extra files", async ({
  page,
}) => {
  await dispatchFiles(
    page,
    "paste",
    Array.from({ length: 11 }, (_, index) => ({
      name: `${index}.png`,
      type: "image/png",
      base64: PNG,
    })),
  );

  await expect(page.locator(".thumb-chip img")).toHaveCount(10);
  await expect(page.getByTestId("attachment-status")).toContainText(
    "Only 10 images",
  );
});

test("an oversized camera-style image is compressed before attachment", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1800;
    canvas.height = 1800;
    const ctx = canvas.getContext("2d")!;
    const pixels = ctx.createImageData(canvas.width, canvas.height);
    let seed = 0x12345678;
    for (let i = 0; i < pixels.data.length; i += 4) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      pixels.data[i] = seed & 255;
      pixels.data[i + 1] = (seed >>> 8) & 255;
      pixels.data[i + 2] = (seed >>> 16) & 255;
      pixels.data[i + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) =>
          value ? resolve(value) : reject(new Error("encode failed")),
        "image/jpeg",
        1,
      ),
    );
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], "camera.jpg", { type: "image/jpeg" }));
    document.querySelector("textarea")?.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      }),
    );
  });

  await expect(page.locator(".thumb-chip img")).toHaveCount(1);
  await expect(page.getByTestId("attachment-status")).toContainText(
    "Compressed 1 oversized image",
  );
});
/** The image-output ToolCard for the settled image turn. The screenshot/mockup is now
 *  surfaced in the turn's always-visible slot (no work-block drill, no summary card), so
 *  we find the card by the <img> it renders unconditionally outside its collapsible body. */
function imageToolCard(page: Page) {
  return page.locator(".tool").filter({ has: page.locator("img.out-img") });
}

test("a user's image attachment is echoed back into the transcript", async ({
  page,
}) => {
  await drive(page, "images");
  await expect(
    page.getByText("can you mock up a cleaner layout?"),
  ).toBeVisible();

  // The composer sent the attachment as a data URL; the user row renders it back as
  // a thumbnail (previously write-only — sent to the agent, never shown to the user).
  const att = page.locator("img.att-img");
  await expect(att).toHaveCount(1);
  await expect(att).toBeVisible();
  await expect(att).toHaveAttribute("src", /^data:image\/png;base64,/);
  // It actually decoded, not just an <img> with a broken src.
  await expect
    .poll(() => att.evaluate((i: HTMLImageElement) => i.naturalWidth))
    .toBeGreaterThan(0);
});

test("a tool's image output is visible without drilling into the collapsed work", async ({
  page,
}) => {
  await drive(page, "images");
  // The screenshot/mockup tool is pulled out of the collapsible work into the turn's
  // always-visible slot, and its <img> renders outside the card's expand toggle — so it
  // shows with NO work-block expand and NO tool-card click. Wait on the <img> itself as
  // the settle signal (this turn no longer renders a "Worked for Ns" block).
  const out = page.locator("img.out-img");
  await expect(out).toBeVisible();
  await expect(out).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect
    .poll(() => out.evaluate((i: HTMLImageElement) => i.naturalWidth))
    .toBeGreaterThan(0);

  // The accompanying text note still lives in the collapsible card body — reveal it.
  const card = imageToolCard(page);
  await card.locator(".head").click();
  await expect(card.getByText("Rendered mockup (160×100 PNG).")).toBeVisible();
});

test("clicking a sent image opens the full-screen viewer", async ({ page }) => {
  await drive(page, "images");
  const att = page.locator("img.att-img");
  await expect(att).toBeVisible();

  // No viewer until the thumbnail is clicked.
  await expect(page.getByTestId("image-lightbox")).toHaveCount(0);
  await att.click();

  const lightbox = page.getByTestId("image-lightbox");
  await expect(lightbox).toBeVisible();
  await expect(lightbox.locator(".stage img")).toHaveAttribute(
    "src",
    /^data:image\/png;base64,/,
  );
  // Escape dismisses.
  await page.keyboard.press("Escape");
  await expect(lightbox).toHaveCount(0);
});

test("clicking a tool's image output opens the full-screen viewer", async ({
  page,
}) => {
  await drive(page, "images");
  const out = page.locator("img.out-img");
  await expect(out).toBeVisible();

  await out.click();
  const lightbox = page.getByTestId("image-lightbox");
  await expect(lightbox).toBeVisible();
  await expect(lightbox.locator(".stage img")).toHaveAttribute(
    "src",
    /^data:image\/png;base64,/,
  );
  // The close button dismisses.
  await lightbox.getByRole("button", { name: "Close preview" }).click();
  await expect(lightbox).toHaveCount(0);
});

test("both images survive a reload (typed images in the state snapshot)", async ({
  page,
}) => {
  await drive(page, "images");
  await expect(page.locator("img.out-img")).toBeVisible();
  // The image data lives in ToolItem.images / UserItem.images, which the server holds in
  // its authoritative SessionState and re-ships on reconnect. Reload WITHOUT resetting:
  // a fresh client must rebuild the same images.
  await page.goto("/?dev");
  await waitForSettledWorkBlocks(page, 1);

  // User attachment — always visible in the user row.
  const att = page.locator("img.att-img");
  await expect(att).toBeVisible();
  await expect
    .poll(() => att.evaluate((i: HTMLImageElement) => i.naturalWidth))
    .toBeGreaterThan(0);

  // Tool output image — visible without any drill, even after a reload.
  const out = page.locator("img.out-img");
  await expect(out).toBeVisible();
  await expect
    .poll(() => out.evaluate((i: HTMLImageElement) => i.naturalWidth))
    .toBeGreaterThan(0);
});

test("a pinned transcript stays at the live bottom as images decode and after reload", async ({
  page,
}) => {
  await drive(page, "images");
  await waitForSettledWorkBlocks(page, 1);

  // Wait for both images to actually decode (not just <img> with a src).
  const att = page.locator("img.att-img");
  const out = page.locator("img.out-img");
  await expect
    .poll(() => att.evaluate((i: HTMLImageElement) => i.naturalWidth))
    .toBeGreaterThan(0);
  await expect
    .poll(() => out.evaluate((i: HTMLImageElement) => i.naturalWidth))
    .toBeGreaterThan(0);

  // ── AC.1, AC.2: gap is near-zero and the final row is above the composer.
  await assertPinnedToBottom(page);

  // Precondition: the content must overflow the viewport for the gap check to be
  // discriminative. If the fixture doesn't produce enough content, the gap is
  // always ~0 regardless of the fix (nothing to scroll).
  const scroller = page.locator(".scroller");
  const scrollable = await scroller.evaluate(
    (el) =>
      (el as HTMLElement).scrollHeight > (el as HTMLElement).clientHeight,
  );
  expect(scrollable).toBe(true);

  // Simulate a LATE image decode (the real failure surface): disable
  // overflow-anchor (Chrome's auto-anchoring masks the bug — see
  // e2e/scroll-drift.e2e.ts for the same technique), let the settle window
  // lapse, then force a small height change that mimics a slow image decode.
  // Without the fix, the ResizeObserver is settle-window-gated and the drift
  // watcher's 200px threshold misses this gap; the final message is clipped.
  await forceLateHeightChange(page, 68);
  await assertPinnedToBottom(page);
  // AC.3: the "New messages ↓" pill never appeared. This is a non-discriminative
  // sanity check — with overflow-anchor off and a DOM-appended spacer, no scroll
  // event fires so `pinned` stays true regardless of the fix. The spurious-unread
  // symptom (which requires live streaming + a scroll event un-pinning) is
  // implicitly covered by AC.1: if the gap stays < 4px, `pinned` never flips and
  // `markActiveUnread` is never called. The pill assertion here guards against a
  // regression where the fix itself accidentally un-pins.
  await expect(page.getByTestId("new-messages-pill")).toHaveCount(0);

  // ── AC.2 (reload): after reload, the same invariant holds.
  await page.goto("/?dev");
  await waitForSettledWorkBlocks(page, 1);
  await expect
    .poll(() => page.locator("img.att-img").evaluate((i: HTMLImageElement) => i.naturalWidth))
    .toBeGreaterThan(0);
  await expect
    .poll(() => page.locator("img.out-img").evaluate((i: HTMLImageElement) => i.naturalWidth))
    .toBeGreaterThan(0);
  await forceLateHeightChange(page, 68);
  await assertPinnedToBottom(page);
});
