import { eq } from "drizzle-orm";
import { ocrRows, photos } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { ReceiptStorage } from "@/ports/receipt-storage";
import { LocalReceiptStorage, validateStorageKey } from "@/adapters/storage/local-receipt-storage";
import { sniffImageType } from "@/lib/upload/guard";
/** Resolve the private object only through the authenticated row's photo. */
export async function loadReceiptImage(db: Db,rowId: string,storage?: ReceiptStorage): Promise<{bytes:Uint8Array;mime:string} | null> {
 const [photo] = await db.select({key:photos.storageKey}).from(ocrRows).innerJoin(photos,eq(ocrRows.photoId,photos.id)).where(eq(ocrRows.id,rowId));
 if (!photo) return null;
 try {
  validateStorageKey(photo.key);
  const bytes = await (storage ?? new LocalReceiptStorage()).get(photo.key);
  const kind = sniffImageType(bytes);
  if (!kind) return null;
  return {bytes,mime:`image/${kind}`};
 } catch { return null; } // Legacy/missing objects have no fabricated preview.
}
