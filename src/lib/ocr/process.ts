/**
 * Async OCR — the slice-4 "OCR off the request path" service.
 *
 * Slice 2 ran OCR synchronously inside `processUpload`. This service is the
 * async half: an OCR row is born PENDING (no extraction yet) and an Inngest job
 * (or any caller) promotes it to CONFIDENT/BLOCKED by running the OCR provider
 * here, out of the request path. It is idempotent — a row that is no longer
 * PENDING is returned untouched (no re-read, no double OCR).
 */

import { withRowLock } from "@/lib/review/locks";
import { eq } from "drizzle-orm";
import { ocrRows, photos } from "@/lib/db/schema";
import { classifyOcrRowStatus } from "@/lib/pipeline/ingest";
import { resolveRowCuit } from "./resolve-cuit";
import { writeAudit } from "@/lib/audit/audit";
import type { OcrProvider } from "@/ports/ocr-provider";
import type { Db } from "@/lib/db/types";

/** Reads a photo's bytes by storage key (injectable; storage adapter is slice 5). */
export type ImageReader = (storageKey: string) => Promise<Uint8Array>;

/**
 * Runs OCR on a PENDING row and promotes it to CONFIDENT or BLOCKED. Idempotent:
 * a non-PENDING row is returned as-is.
 */
export async function processOcrRow(
  db: Db,
  ocr: OcrProvider,
  rowId: string,
  getImage: ImageReader,
): Promise<{ id: string; status: string }> {
  const [row] = await db.select().from(ocrRows).where(eq(ocrRows.id, rowId));
  if (!row) return { id: rowId, status: "DELETED" };
  if (row.status !== "PENDING") {
    return { id: row.id, status: row.status };
  }

  const [photo] = await db
    .select()
    .from(photos)
    .where(eq(photos.id, row.photoId));
  if (!photo) return withRowLock(db, rowId, async tx => {
    const [current] = await tx.select({id: ocrRows.id}).from(ocrRows).where(eq(ocrRows.id, rowId));
    if (!current) return {id: rowId, status: "DELETED"};
    throw new Error(`processOcrRow: no photo for OCR row ${rowId}`);
  });

  // External OCR must not block deletion. Re-read under the mutation lock afterwards.
  let result: Awaited<ReturnType<OcrProvider["extract"]>>;
  try {
    const image = await getImage(photo.storageKey);
    result = await ocr.extract(image);
  } catch (err) {
    return withRowLock(db, rowId, async tx => {
      const [current] = await tx.select().from(ocrRows).where(eq(ocrRows.id, rowId));
      if (!current) return {id: rowId, status: "DELETED"};
      if (current.status !== "PENDING") return {id: rowId, status: current.status};
      const message = err instanceof Error ? err.message : String(err);
      await tx.update(ocrRows).set({status: "FAILED", error: message}).where(eq(ocrRows.id, rowId));
      return {id: rowId, status: "FAILED"};
    });
  }
  return withRowLock(db, rowId, async tx => {
    const [current] = await tx.select().from(ocrRows).where(eq(ocrRows.id, rowId));
    if (!current) return {id: rowId, status: "DELETED"};
    if (current.status !== "PENDING") return {id: rowId, status: current.status};
    const status = classifyOcrRowStatus(result.confidence);
    const {cuit, cuitSource, matchedBy} = await resolveRowCuit(tx, result, current.recipientMode);
    if (matchedBy) await writeAudit(tx, {actor: "system", action: "payer.cuit_registry_resolved", rowId, payload: {matchedBy}});
    await tx.update(ocrRows).set({fields: result.fields, confidence: result.confidence, cuit, cuitSource, status, error: null}).where(eq(ocrRows.id, rowId));
    return {id: rowId, status};
  });
}
