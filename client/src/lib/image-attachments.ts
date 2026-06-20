import type { ImageContent } from "@pilot/protocol";

export const IMAGE_LIMITS = {
  count: 10,
  sourceFileBytes: 20 * 1024 * 1024,
  sourceBatchBytes: 40 * 1024 * 1024,
  processedFileBytes: 5 * 1024 * 1024,
  processedTotalBytes: 12 * 1024 * 1024,
  compressAboveBytes: 2.5 * 1024 * 1024,
  maxDimension: 2048,
} as const;

const WIRE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
const SUPPORTED_TYPES = new Set([
  ...WIRE_TYPES,
  // Camera pickers may expose HEIC/HEIF. These are accepted only as conversion inputs;
  // they must decode to JPEG before reaching pi/provider APIs.
  "image/heic",
  "image/heif",
]);

export interface ImageFileLike {
  name: string;
  type: string;
  size: number;
}

export interface ImageSelection {
  accepted: number[];
  errors: string[];
}

function mb(bytes: number): string {
  return `${Math.ceil((bytes / 1024 / 1024) * 10) / 10} MB`;
}

/** Fast validation that runs before any FileReader/base64 or image decode work. */
export function validateImageSelection(
  files: readonly ImageFileLike[],
  existingCount: number,
): ImageSelection {
  const accepted: number[] = [];
  const errors: string[] = [];
  let sourceBytes = 0;
  for (let index = 0; index < files.length; index++) {
    const file = files[index]!;
    if (existingCount + accepted.length >= IMAGE_LIMITS.count) {
      errors.push(`Only ${IMAGE_LIMITS.count} images can be attached.`);
      break;
    }
    if (!SUPPORTED_TYPES.has(file.type)) {
      errors.push(`${file.name}: unsupported image type.`);
      continue;
    }
    if (file.size <= 0) {
      errors.push(`${file.name}: empty file.`);
      continue;
    }
    if (file.size > IMAGE_LIMITS.sourceFileBytes) {
      errors.push(
        `${file.name}: ${mb(file.size)} exceeds the ${mb(IMAGE_LIMITS.sourceFileBytes)} source limit.`,
      );
      continue;
    }
    if (sourceBytes + file.size > IMAGE_LIMITS.sourceBatchBytes) {
      errors.push(
        `Selected images exceed the ${mb(IMAGE_LIMITS.sourceBatchBytes)} batch limit.`,
      );
      break;
    }
    sourceBytes += file.size;
    accepted.push(index);
  }
  return { accepted, errors: [...new Set(errors)] };
}

export function base64ByteLength(data: string): number {
  if (!data) return 0;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error("Could not read the image"));
    reader.onload = () => {
      const raw = reader.result;
      if (typeof raw !== "string") {
        reject(new Error("Could not read the image"));
        return;
      }
      resolve(raw.slice(raw.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}

function canvasBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("Browser image encoding failed")),
      type,
      quality,
    ),
  );
}

async function compressImage(file: File): Promise<Blob> {
  if (
    (file.size <= IMAGE_LIMITS.compressAboveBytes && WIRE_TYPES.has(file.type)) ||
    file.type === "image/gif"
  )
    return file;
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(
      1,
      IMAGE_LIMITS.maxDimension / Math.max(bitmap.width, bitmap.height),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Browser image canvas is unavailable");
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const outputType =
      file.type === "image/jpeg" ||
      file.type === "image/heic" ||
      file.type === "image/heif"
        ? "image/jpeg"
        : "image/webp";
    let best = await canvasBlob(canvas, outputType, 0.84);
    for (const quality of [0.74, 0.64]) {
      if (best.size <= IMAGE_LIMITS.compressAboveBytes) break;
      const candidate = await canvasBlob(canvas, outputType, quality);
      if (candidate.size < best.size) best = candidate;
    }
    // HEIC/HEIF are conversion-only inputs: never return the original unsupported
    // MIME even when the JPEG happens to be larger.
    return !WIRE_TYPES.has(file.type) || best.size < file.size ? best : file;
  } finally {
    bitmap.close();
  }
}

export interface PreparedImages {
  images: ImageContent[];
  errors: string[];
  compressedCount: number;
}

/** Validate, optionally downscale/re-encode, enforce processed-byte limits, then base64. */
export async function prepareImageFiles(
  files: readonly File[],
  existing: readonly ImageContent[],
): Promise<PreparedImages> {
  const selection = validateImageSelection(files, existing.length);
  const errors = [...selection.errors];
  const images: ImageContent[] = [];
  let compressedCount = 0;
  let totalBytes = existing.reduce(
    (sum, image) => sum + base64ByteLength(image.data),
    0,
  );

  for (const index of selection.accepted) {
    const file = files[index]!;
    let blob: Blob;
    try {
      blob = await compressImage(file);
    } catch {
      // Decode/encode support varies (notably odd camera formats). Keep an already-small
      // supported file; reject a large one rather than base64-expanding it unchecked.
      if (
        WIRE_TYPES.has(file.type) &&
        file.size <= IMAGE_LIMITS.processedFileBytes
      )
        blob = file;
      else {
        errors.push(`${file.name}: could not compress this image.`);
        continue;
      }
    }
    if (blob.size > IMAGE_LIMITS.processedFileBytes) {
      errors.push(
        `${file.name}: still exceeds ${mb(IMAGE_LIMITS.processedFileBytes)} after compression.`,
      );
      continue;
    }
    if (totalBytes + blob.size > IMAGE_LIMITS.processedTotalBytes) {
      errors.push(
        `Attachments exceed the ${mb(IMAGE_LIMITS.processedTotalBytes)} total limit.`,
      );
      break;
    }
    try {
      const data = await blobToBase64(blob);
      images.push({ type: "image", data, mimeType: blob.type || file.type });
      totalBytes += blob.size;
      if (blob !== file) compressedCount++;
    } catch {
      errors.push(`${file.name}: could not read this image.`);
    }
  }

  return { images, errors: [...new Set(errors)], compressedCount };
}
