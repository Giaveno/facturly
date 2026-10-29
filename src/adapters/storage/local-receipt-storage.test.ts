import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalReceiptStorage, validateStorageKey } from "@/adapters/storage/local-receipt-storage";

describe("local receipt storage", () => {
  it("round trips and deletes opaque image keys inside its root", async () => {
    const root = await mkdtemp(join(tmpdir(), "facturly-storage-"));
    try {
      const storage = new LocalReceiptStorage(root);
      const key = "550e8400-e29b-41d4-a716-446655440000.jpg";
      const bytes = new Uint8Array([1, 2, 3]);
      await storage.put(key, bytes, "image/jpeg");
      expect([...await storage.get(key)]).toEqual([1, 2, 3]);
      await storage.delete(key);
      await expect(storage.get(key)).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each(["../secret.jpg", "sub/key.jpg", "/absolute.jpg", "x.txt"])("rejects unsafe key %s", (key) => {
    expect(() => validateStorageKey(key)).toThrow();
  });
});
