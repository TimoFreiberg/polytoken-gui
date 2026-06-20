import { expect, type Page, test } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

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
        document
          .querySelector("textarea")
          ?.dispatchEvent(
            new ClipboardEvent("paste", {
              clipboardData: transfer,
              bubbles: true,
              cancelable: true,
            }),
          );
      } else {
        document
          .querySelector(".composer-wrap")
          ?.dispatchEvent(
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
        (value) => (value ? resolve(value) : reject(new Error("encode failed"))),
        "image/jpeg",
        1,
      ),
    );
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([blob], "camera.jpg", { type: "image/jpeg" }),
    );
    document
      .querySelector("textarea")
      ?.dispatchEvent(
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
