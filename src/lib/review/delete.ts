import { eq, inArray, isNull, or, sql } from "drizzle-orm";
import { auditLog, batches, invoices, issuedInvoices, ocrRows, photos, receiptCleanup } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { ReceiptStorage } from "@/ports/receipt-storage";
import { withRowLock } from "./locks";

export class ReceiptDeletionStateError extends Error {}
export interface ReceiptDeletionResult { deleted: boolean; cleanup: "complete" | "pending" }

/** DB deletion commits before file I/O. The outbox makes a crash/failure retryable. */
export async function deleteReceiptRow(db: Db, storage: ReceiptStorage, rowId: string): Promise<ReceiptDeletionResult> {
  const deleted = await withRowLock(db, rowId, async tx => {
    const [row] = await tx.select().from(ocrRows).where(eq(ocrRows.id, rowId));
    if (!row) return false;
    const related = await tx.select().from(invoices).where(eq(invoices.ocrRowId, rowId)).for("update");
    const invoiceIds = related.map(invoice => invoice.id);
    if (related.some(invoice => !["PENDING", "REVIEWED", "REJECTED"].includes(invoice.status))) {
      throw new ReceiptDeletionStateError("No se puede eliminar un comprobante aprobado o con actividad fiscal.");
    }
    if (invoiceIds.length && (await tx.select({id: issuedInvoices.id}).from(issuedInvoices).where(inArray(issuedInvoices.invoiceId, invoiceIds))).length) {
      throw new ReceiptDeletionStateError("El comprobante tiene una reserva fiscal y no se puede eliminar.");
    }
    const [photo] = await tx.select().from(photos).where(eq(photos.id, row.photoId));
    if (!photo) throw new Error("Receipt photo missing");
    // Serialize final-reference cleanup for shared photos/keys, including across batches.
    await tx.select({id: photos.id}).from(photos).where(eq(photos.storageKey, photo.storageKey)).orderBy(photos.id).for("update");
    await tx.select({id: batches.id}).from(batches).where(eq(batches.id, photo.batchId)).for("update");
    const affected = await tx.select().from(auditLog).where(invoiceIds.length
      ? or(eq(auditLog.rowId, rowId), inArray(auditLog.invoiceId, invoiceIds)) : eq(auditLog.rowId, rowId));
    for (const audit of affected) {
      // Preserve event identity/history, but remove receipt data from affected payloads.
      const detachRow = audit.rowId === rowId;
      const detachInvoice = audit.invoiceId !== null && invoiceIds.includes(audit.invoiceId);
      await tx.update(auditLog).set({
        ...(detachRow ? {rowId: null} : {}), ...(detachInvoice ? {invoiceId: null} : {}),
        payload: {...(detachRow ? {deletedRowId: rowId} : {}), ...(detachInvoice ? {deletedInvoiceId: audit.invoiceId} : {})},
      }).where(eq(auditLog.id, audit.id));
    }
    if (invoiceIds.length) await tx.delete(invoices).where(inArray(invoices.id, invoiceIds));
    await tx.delete(ocrRows).where(eq(ocrRows.id, rowId));
    const remainingRows = await tx.select({id: ocrRows.id}).from(ocrRows).where(eq(ocrRows.photoId, photo.id)).limit(1);
    if (!remainingRows.length) {
      await tx.delete(photos).where(eq(photos.id, photo.id));
      if (!(await tx.select({id: photos.id}).from(photos).where(eq(photos.storageKey, photo.storageKey)).limit(1)).length) {
        await tx.insert(receiptCleanup).values({rowId, storageKey: photo.storageKey});
      }
      if (!(await tx.select({id: photos.id}).from(photos).where(eq(photos.batchId, photo.batchId)).limit(1)).length) {
        await tx.delete(batches).where(eq(batches.id, photo.batchId));
      }
    }
    await tx.insert(auditLog).values({actor: "accountant", action: "row.deleted", payload: {rowId, invoiceIds, photoId: photo.id}});
    return true;
  });
  const [entry] = await db.select().from(receiptCleanup).where(eq(receiptCleanup.rowId, rowId));
  if (!entry || entry.completedAt) return {deleted, cleanup: "complete"};
  const complete = await attemptReceiptCleanup(db, storage, entry.id);
  return {deleted, cleanup: complete ? "complete" : "pending"};
}

async function attemptReceiptCleanup(db: Db, storage: ReceiptStorage, id: string): Promise<boolean> {
  try {
    return await db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      const [entry] = await tx.select().from(receiptCleanup).where(eq(receiptCleanup.id, id)).for("update");
      if (!entry || entry.completedAt) return true;
      // Never delete a file if another live photo now references it.
      if ((await tx.select({id: photos.id}).from(photos).where(eq(photos.storageKey, entry.storageKey)).limit(1)).length) return false;
      await storage.delete(entry.storageKey); // Idempotent after crash between unlink and commit.
      await tx.update(receiptCleanup).set({completedAt: new Date()}).where(eq(receiptCleanup.id, id));
      return true;
    });
  } catch { return false; } // Keep pending, without persisting sensitive adapter errors.
}

/** Bounded sweep for the signed background scheduler; no fiscal services involved. */
export async function retryReceiptCleanup(db: Db, storage: ReceiptStorage): Promise<{completed: number; pending: number}> {
  const entries = await db.select({id: receiptCleanup.id}).from(receiptCleanup).where(isNull(receiptCleanup.completedAt)).orderBy(sql`${receiptCleanup.createdAt} ASC`).limit(100);
  let completed = 0;
  for (const entry of entries) if (await attemptReceiptCleanup(db, storage, entry.id)) completed++;
  return {completed, pending: entries.length - completed};
}
