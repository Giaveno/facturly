/**
 * Upload guard — the ONLY untrusted boundary of the app. Every upload is
 * validated BEFORE its bytes are buffered in full, so a hostile or accidental
 * oversized/non-image body cannot exhaust memory.
 *
 * All limits and magic-byte checks live here as pure functions so the route
 * stays thin and this policy is unit-testable without a running server.
 */

import { randomUUID } from "node:crypto";
import type { UploadImage } from "@/lib/pipeline/ingest";

/** Maximum number of photos accepted per upload. */
export const MAX_PHOTO_COUNT = 10;
/** Maximum bytes per photo (10 MiB). */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
/** Maximum total bytes per request (25 MiB). */
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

/** Declared Content-Type values we accept. */
const ALLOWED_DECLARED_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export type ImageKind = "jpeg" | "png" | "webp";

/**
 * Identifies an image by its magic bytes (NOT its declared Content-Type, which
 * the client controls). Returns null when the bytes are not a supported image.
 *
 *   JPEG: FF D8 FF
 *   PNG:  89 50 4E 47 0D 0A 1A 0A
 *   WebP: RIFF .... WEBP
 */
export function sniffImageType(bytes: Uint8Array): ImageKind | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "webp";
  }
  return null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `value` is a canonical (hyphenated) UUID v4-shaped string. */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Derives a server-side storage key from the sniffed image kind. */
function storageKeyFor(kind: ImageKind): string {
  const ext = kind === "jpeg" ? "jpg" : kind;
  return `${randomUUID()}.${ext}`;
}

export type UploadGuardResult =
  | { ok: true; images: UploadImage[] }
  | { ok: false; status: number; code: string; message: string };

function reject(
  status: number,
  code: string,
  message: string,
): UploadGuardResult {
  return { ok: false, status, code, message };
}

/**
 * Validates an upload BEFORE buffering: count, per-file and total byte budget,
 * declared Content-Type, and magic-byte sniffing. On success, each image gets a
 * server-side storage key (UUID + sniffed extension) — the client-controlled
 * field name is never used, so a later slice cannot be tricked into writing a
 * path from the form field.
 */
export async function validateUploadPhotos(
  files: File[],
): Promise<UploadGuardResult> {
  if (files.length === 0) {
    return reject(400, "EMPTY_UPLOAD", "at least one photo is required");
  }
  if (files.length > MAX_PHOTO_COUNT) {
    return reject(
      400,
      "TOO_MANY_FILES",
      `at most ${MAX_PHOTO_COUNT} photos per upload`,
    );
  }

  let total = 0;
  for (const f of files) {
    if (f.size === 0) {
      return reject(400, "EMPTY_FILE", "photo must not be empty");
    }
    if (f.size > MAX_PHOTO_BYTES) {
      return reject(413, "FILE_TOO_LARGE", "photo exceeds the size limit");
    }
    total += f.size;
  }
  if (total > MAX_TOTAL_BYTES) {
    return reject(413, "TOTAL_TOO_LARGE", "upload exceeds the total size limit");
  }

  const images: UploadImage[] = [];
  for (const f of files) {
    if (!ALLOWED_DECLARED_TYPES.has(f.type)) {
      return reject(
        400,
        "UNSUPPORTED_TYPE",
        `unsupported file type "${f.type || "(none)"}"`,
      );
    }
    // Only now that size/type pass do we allocate the content buffer.
    const bytes = new Uint8Array(await f.arrayBuffer());
    const kind = sniffImageType(bytes);
    if (kind === null) {
      return reject(
        400,
        "UNSUPPORTED_TYPE",
        "file content is not a supported image",
      );
    }
    images.push({ storageKey: storageKeyFor(kind), image: bytes });
  }

  return { ok: true, images };
}
