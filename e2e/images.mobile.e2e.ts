import { expect, test } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=",
  "base64",
);

test("the mobile picker accepts images and supports image-only send", async ({
  page,
}) => {
  await gotoFresh(page);
  const input = page.locator('input[type="file"]');
  await expect(input).toHaveAttribute("accept", "image/*");
  await expect(input).toHaveAttribute("multiple", "");
  await input.setInputFiles({
    name: "mobile-screenshot.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  await expect(page.locator(".thumb-chip img")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeEnabled();
});
