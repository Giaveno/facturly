import { eq } from "drizzle-orm";
import { invoices, ocrRows } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

/** All review mutations lock the OCR row first, then re-read invoice state.
 * This also serializes missing-invoice materialization without a new index. */
export async function withRowLock<T>(db: Db, rowId: string, operation: (tx: Db) => Promise<T>): Promise<T> {
 return db.transaction(async transaction => {
  const tx = transaction as unknown as Db;
  await tx.select({id: ocrRows.id}).from(ocrRows).where(eq(ocrRows.id,rowId)).for("update");
  return operation(tx);
 });
}
export async function withInvoiceLock<T>(db: Db, invoiceId: string, operation: (tx: Db) => Promise<T>): Promise<T> {
 const [invoice] = await db.select({rowId:invoices.ocrRowId}).from(invoices).where(eq(invoices.id,invoiceId));
 if (!invoice) throw new Error("Invoice not found");
 return withRowLock(db,invoice.rowId,operation);
}
