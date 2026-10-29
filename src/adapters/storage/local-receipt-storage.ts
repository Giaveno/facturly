import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve, sep } from "node:path";
import type { ReceiptStorage } from "@/ports/receipt-storage";

const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/i;
const TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function validateStorageKey(key: string): void {
  if (!KEY.test(key)) throw new Error("Invalid receipt storage key");
}

/** Local-only adapter. Never suitable for multi-instance or ephemeral production deployments. */
export class LocalReceiptStorage implements ReceiptStorage {
  private readonly root: string;
  constructor(root = resolve(process.cwd(), ".data", "uploads")) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Production receipt storage adapter is not configured");
    }
    this.root = resolve(root);
  }
  private path(key: string): string {
    validateStorageKey(key);
    const path = resolve(this.root, key);
    if (!path.startsWith(this.root + sep)) throw new Error("Invalid receipt storage key");
    return path;
  }
  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    if (!TYPES.has(contentType)) throw new Error("Unsupported receipt content type");
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.path(key)));
  }
  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}
