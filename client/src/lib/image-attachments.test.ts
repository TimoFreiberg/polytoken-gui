import { describe, expect, test } from "bun:test";
import {
  base64ByteLength,
  IMAGE_LIMITS,
  validateImageSelection,
} from "./image-attachments.js";

const file = (
  name: string,
  type = "image/png",
  size = 100,
): { name: string; type: string; size: number } => ({ name, type, size });

describe("validateImageSelection", () => {
  test("accepts supported image types", () => {
    expect(
      validateImageSelection(
        [
          file("a.jpg", "image/jpeg"),
          file("b.png"),
          file("c.webp", "image/webp"),
          file("d.gif", "image/gif"),
          file("camera.heic", "image/heic"),
        ],
        0,
      ).accepted,
    ).toEqual([0, 1, 2, 3, 4]);
  });

  test("rejects unsupported, empty, and oversized source files before reading", () => {
    const result = validateImageSelection(
      [
        file("vector.svg", "image/svg+xml"),
        file("empty.png", "image/png", 0),
        file("huge.jpg", "image/jpeg", IMAGE_LIMITS.sourceFileBytes + 1),
      ],
      0,
    );
    expect(result.accepted).toEqual([]);
    expect(result.errors.join(" ")).toContain("unsupported");
    expect(result.errors.join(" ")).toContain("empty");
    expect(result.errors.join(" ")).toContain("source limit");
  });

  test("enforces the count limit across existing attachments", () => {
    const result = validateImageSelection(
      [file("a.png"), file("b.png"), file("c.png")],
      IMAGE_LIMITS.count - 1,
    );
    expect(result.accepted).toEqual([0]);
    expect(result.errors).toContain(
      `Only ${IMAGE_LIMITS.count} images can be attached.`,
    );
  });

  test("enforces the source batch limit before base64 expansion", () => {
    const each = 14 * 1024 * 1024;
    const result = validateImageSelection(
      [
        file("a.jpg", "image/jpeg", each),
        file("b.jpg", "image/jpeg", each),
        file("c.jpg", "image/jpeg", each),
      ],
      0,
    );
    expect(result.accepted).toEqual([0, 1]);
    expect(result.errors.join(" ")).toContain("batch limit");
  });
});

describe("base64ByteLength", () => {
  test("accounts for padding", () => {
    expect(base64ByteLength("TQ==")).toBe(1);
    expect(base64ByteLength("TWE=")).toBe(2);
    expect(base64ByteLength("TWFu")).toBe(3);
  });
});
