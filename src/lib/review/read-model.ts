/**
 * Review read-model — the rows shown on the review screen, joined to their
 * client. This is a read concern unrelated to ingestion, so it lives here
 * rather than in the upload pipeline.
 */

import { eq } from "drizzle-orm";
import { auditLog, batches, clients, ocrRows, photos, type CuitSource } from "@/lib/db/schema";
import { isValidCuit } from "@/domain/cuit";
import type { RecipientMode } from "@/domain/receipt";
import type { CondicionIVA } from "@/domain/policy";
import { materializeInvoice, ReviewRowNotFoundError } from "./workflow";
import type { OcrFields } from "@/ports/ocr-provider";
import type { Db } from "@/lib/db/types";

export interface ReviewRow {
  rowId: string;
  status: string;
  cuit: string | null;
  /** Where `cuit` came from: OCR, the registry read side, or a manual entry. */
  cuitSource: CuitSource | null;
  recipientMode: RecipientMode;
  recipientModeSource: string;
  taxRate: number | null;
  issuerCondition: CondicionIVA;
  fields: OcrFields;
  confidence: Record<string, number>;
  manualFields: string[];
  issuerCuit: string;
  ptoVta: number;
  clientId: string;
  razonSocial: string;
  /** UI hint only — see `isRowEmittable` for the real enforcement. */
  blocked: boolean;
  /** True when the async OCR crashed. A FAILED row is non-emittable AND, since
   * the C1 fix, can no longer be flipped to CORRECTED by payer resolution — it
   * requires a re-OCR (out of scope), never a CUIT assignment. */
  failed: boolean;
  /** The OCR failure reason, when `failed` is true. */
  error: string | null;
}

/**
 * A review row PLUS its materialized invoice — the shape the review page needs
 * to wire approve/reject/resolve actions (which operate on the invoice id and
 * the invoice status).
 */
export interface ReviewInvoiceRow extends ReviewRow {
  invoiceId: string;
  invoiceStatus: string;
  /** True when the payer CUIT is missing/invalid — needs manual resolution. */
  flagged: boolean;
}

/**
 * Lists rows for the review table, joined to their client, with a `blocked`
 * flag the UI uses to hide the approve action (blocked rows are unapprovable).
 * The flag is a presentation hint; emission enforcement lives in
 * `@/domain/emission`.
 */
export async function listReviewRows(db: Db): Promise<ReviewRow[]> {
  const rows = await db
    .select({
      rowId: ocrRows.id,
      status: ocrRows.status,
      cuit: ocrRows.cuit,
      cuitSource: ocrRows.cuitSource,
      recipientMode: ocrRows.recipientMode,
      recipientModeSource: ocrRows.recipientModeSource,
      taxRate: ocrRows.taxRate,
      issuerCondition: clients.condicionIva,
      fields: ocrRows.fields,
      confidence: ocrRows.confidence,
      issuerCuit: clients.cuit,
      ptoVta: clients.ptoVta,
      clientId: batches.clientId,
      razonSocial: clients.razonSocial,
      error: ocrRows.error,
    })
    .from(ocrRows)
    .innerJoin(photos, eq(ocrRows.photoId, photos.id))
    .innerJoin(batches, eq(photos.batchId, batches.id))
    .innerJoin(clients, eq(batches.clientId, clients.id))
    .orderBy(ocrRows.createdAt);

  const corrections = await db.select({rowId:auditLog.rowId,payload:auditLog.payload}).from(auditLog).where(eq(auditLog.action,"row.corrected"));
  return rows.map((r) => ({
    manualFields: [...new Set(corrections.filter(a=>a.rowId===r.rowId).flatMap(a=>{
      const fields = (a.payload as {changedFields?: unknown} | null)?.changedFields;
      return Array.isArray(fields) ? fields.filter((key): key is string=>typeof key === "string") : [];
    }))],
    ...r,
    blocked: r.status === "BLOCKED",
    failed: r.status === "FAILED",
  }));
}

/** Materializes missing invoices without confirming review or rewinding fiscal state. */
export async function listReviewInvoices(db: Db): Promise<ReviewInvoiceRow[]> {
  const rows = await listReviewRows(db);
  const out: ReviewInvoiceRow[] = [];
  for (const r of rows) {
    let invoice: Awaited<ReturnType<typeof materializeInvoice>>;
    try { invoice = await materializeInvoice(db, r.rowId); }
    catch (error) {
      if (error instanceof ReviewRowNotFoundError) continue; // Deleted after initial fetch.
      throw error;
    }
    out.push({
      ...r,
      invoiceId: invoice.id,
      invoiceStatus: invoice.status,
      flagged: r.recipientMode === "identified" && (!r.cuit || !isValidCuit(r.cuit)),
    });
  }
  return out;
}
