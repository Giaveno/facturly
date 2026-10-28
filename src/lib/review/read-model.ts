/**
 * Review read-model — the rows shown on the review screen, joined to their
 * client. This is a read concern unrelated to ingestion, so it lives here
 * rather than in the upload pipeline.
 */

import { eq } from "drizzle-orm";
import { batches, clients, ocrRows, photos, type CuitSource } from "@/lib/db/schema";
import { isValidCuit } from "@/domain/cuit";
import { materializeInvoice } from "./workflow";
import type { OcrFields } from "@/ports/ocr-provider";
import type { Db } from "@/lib/db/types";

export interface ReviewRow {
  rowId: string;
  status: string;
  cuit: string | null;
  /** Where `cuit` came from: OCR, the registry read side, or a manual entry. */
  cuitSource: CuitSource | null;
  fields: OcrFields;
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
      fields: ocrRows.fields,
      clientId: batches.clientId,
      razonSocial: clients.razonSocial,
      error: ocrRows.error,
    })
    .from(ocrRows)
    .innerJoin(photos, eq(ocrRows.photoId, photos.id))
    .innerJoin(batches, eq(photos.batchId, batches.id))
    .innerJoin(clients, eq(batches.clientId, clients.id))
    .orderBy(ocrRows.createdAt);

  return rows.map((r) => ({
    ...r,
    blocked: r.status === "BLOCKED",
    failed: r.status === "FAILED",
  }));
}

/**
 * Lists review rows AND materializes each row's invoice (the documented
 * "materialize at review time" step). The materialization is now a GUARDED
 * upsert: it only CREATES a missing invoice and only PROMOTES PENDING → REVIEWED
 * — it can never regress an APPROVED/EMITTING/EMITTED/EMIT_ERROR/EMIT_FAILED/
 * REJECTED invoice, so a page GET cannot rewind fiscal state (C2). Kept SEPARATE
 * from the pure `listReviewRows` so existing callers (demo, ingest tests) are
 * unaffected.
 */
export async function listReviewInvoices(db: Db): Promise<ReviewInvoiceRow[]> {
  const rows = await listReviewRows(db);
  const out: ReviewInvoiceRow[] = [];
  for (const r of rows) {
    const invoice = await materializeInvoice(db, r.rowId);
    out.push({
      ...r,
      invoiceId: invoice.id,
      invoiceStatus: invoice.status,
      flagged: !r.cuit || !isValidCuit(r.cuit),
    });
  }
  return out;
}
