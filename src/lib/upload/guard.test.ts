import { describe, it, expect } from "vitest";
import {
  MAX_PHOTO_COUNT,
  MAX_PHOTO_BYTES,
  sniffImageType,
  validateUploadPhotos,
  isUuid,
} from "./guard";

const jpegBytes = () =>
  new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x00, 0x00]);
const pngBytes = () =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const webpBytes = () => {
  const b = new Uint8Array(12);
  b.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  b.set([0x00, 0x00, 0x00, 0x00], 4); // size
  b.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  return b;
};

describe("sniffImageType — magic-byte detection", () => {
  it("detects JPEG (FF D8 FF)", () => {
    expect(sniffImageType(jpegBytes())).toBe("jpeg");
  });

  it("detects PNG (89 50 4E 47 ...)", () => {
    expect(sniffImageType(pngBytes())).toBe("png");
  });

  it("detects WebP (RIFF .... WEBP)", () => {
    expect(sniffImageType(webpBytes())).toBe("webp");
  });

  it("rejects non-image bytes (text) as null", () => {
    const text = new TextEncoder().encode("this is not an image");
    expect(sniffImageType(text)).toBeNull();
  });

  it("rejects too-short input", () => {
    expect(sniffImageType(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });
});

describe("validateUploadPhotos — pre-allocation limits", () => {
  const file = (
    name: string,
    bytes: Uint8Array,
    type = "image/jpeg",
  ): File => new File([bytes as BlobPart], name, { type });

  it("rejects an empty upload (no files)", async () => {
    const r = await validateUploadPhotos([]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.code).toBe("EMPTY_UPLOAD");
    }
  });

  it("rejects too many files", async () => {
    const files = Array.from({ length: MAX_PHOTO_COUNT + 1 }, (_, i) =>
      file(`p${i}.jpg`, jpegBytes()),
    );
    const r = await validateUploadPhotos(files);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.code).toBe("TOO_MANY_FILES");
    }
  });

  it("rejects an oversized file with 413", async () => {
    const big = new Uint8Array(MAX_PHOTO_BYTES + 1);
    big.set(jpegBytes(), 0); // still image bytes, just too large
    const r = await validateUploadPhotos([file("big.jpg", big)]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(413);
      expect(r.code).toBe("FILE_TOO_LARGE");
    }
  });

  it("rejects a zero-byte file", async () => {
    const r = await validateUploadPhotos([file("empty.jpg", new Uint8Array(0))]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.code).toBe("EMPTY_FILE");
    }
  });

  it("rejects a file whose bytes are not really an image (magic-byte mismatch)", async () => {
    const fake = new TextEncoder().encode("definitely not a picture");
    const r = await validateUploadPhotos([file("fake.jpg", fake, "image/jpeg")]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.code).toBe("UNSUPPORTED_TYPE");
    }
  });

  it("rejects a file with an undeclared/non-image Content-Type", async () => {
    const r = await validateUploadPhotos([
      file("x.bin", jpegBytes(), "application/octet-stream"),
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.code).toBe("UNSUPPORTED_TYPE");
    }
  });

  it("accepts valid images and derives a server-side storage key from the sniffed kind", async () => {
    const r = await validateUploadPhotos([
      file("a.jpg", jpegBytes()),
      file("b.png", pngBytes(), "image/png"),
      file("c.webp", webpBytes(), "image/webp"),
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.images).toHaveLength(3);
      expect(r.images[0]!.storageKey).toMatch(/\.jpg$/);
      expect(r.images[1]!.storageKey).toMatch(/\.png$/);
      expect(r.images[2]!.storageKey).toMatch(/\.webp$/);
      // The form field name must never leak into the storage key (path-traversal).
      for (const img of r.images) {
        expect(img.storageKey).not.toContain("/");
        expect(img.storageKey).not.toContain("..");
      }
    }
  });
});

describe("isUuid — clientId validation", () => {
  it("accepts a valid UUID", () => {
    expect(isUuid("6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(true);
  });

  it("rejects non-UUID strings", () => {
    expect(isUuid("client-123")).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid("../../etc/passwd")).toBe(false);
  });
});
