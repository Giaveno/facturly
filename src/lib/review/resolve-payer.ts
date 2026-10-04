/**
 * Payer CUIT resolution — unblocks flagged rows (no/invalid payer CUIT).
 *
 * A bank-transfer receipt generally omits the sender CUIT; the row is flagged
 * for review and cannot be emitted. The accountant enters the payer's CUIT here:
 *   1. the CUIT is validated with the Mod-11 check,
 *   2. the GLOBAL payer registry LEARNS it (match by CBU/CVU/alias/name → update,
 *      else insert with `learnedFrom = 'manual'`),
 *   3. the OCR row is marked CORRECTED so the invoice follows the documented
 *      CORRECTED ⇒ REVIEWED path (via `materializeInvoice`, the existing
 *      transition — no new transition is invented),
 *   4. the resolution is audited.
 */

import { eq } from "drizzle-orm";
import { invoices, ocrRows } from "@/lib/db/schema";
import { isValidCuit } from "@/domain/cuit";
import { upsertPayer } from "@/lib/db/payers";
import { writeAudit } from "@/lib/audit/audit";
import { materializeInvoice } from "./workflow";
import type { Db } from "@/lib/db/types";

/** Thrown when the entered CUIT is not Mod-11 valid (mapped to 400). */
export class PayerCuitInvalidError extends Error {
  constructor(cuit: string) {
    super(`"${cuit}" is not a valid CUIT`);
    this.name = "PayerCuitInvalidError";
  }
}

/** Thrown when the OCR row does not exist (mapped to 404). */
export class RowNotFoundError extends Error {
  constructor(rowId: string) {
    super(`No OCR row with id ${rowId}`);
    this.name = "RowNotFoundError";
  }
}

/** Thrown when the row/invoice state forbids payer resolution (mapped to 409). */
export class RowNotResolvableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "RowNotResolvableError";
  }
}

/**
 * Row states a payer CUIT may be resolved onto. A FAILED row (crashed OCR) is
 * deliberately EXCLUDED — it needs a re-OCR/explicit correction, not a CUIT
 * assignment. A PENDING row (async OCR still in flight) and an already-CORRECTED
 * row are also refused.
 */
const RESOLVABLE_ROW_STATUSES: ReadonlySet<string> = new Set([
  "CONFIDENT",
  "BLOCKED",
]);

/**
 * Invoice states under which a row may NEVER be resolved — a terminal/in-flight
 * invoice (already approved, emitting, emitted, or rejected) must not be
 * re-promoted to REVIEWED by a payer resolution.
 */
const TERMINAL_INVOICE_STATUSES: ReadonlySet<string> = new Set([
  "APPROVED",
  "EMITTING",
  "EMITTED",
  "EMIT_ERROR",
  "EMIT_FAILED",
  "REJECTED",
]);

export interface ResolvePayerResult {
  rowId: string;
  status: "CORRECTED";
  invoiceId: string;
  invoiceStatus: string;
  learnedFrom: string;
  inserted: boolean;
}

/**
 * Resolves a flagged row's payer CUIT, teaching the registry and promoting the
 * row to CORRECTED (invoice → REVIEWED). Returns the materialized invoice state
 * so the caller can confirm the row is now approvable.
 */
export async function resolvePayerCuit(
  db: Db,
  rowId: string,
  cuit: string,
): Promise<ResolvePayerResult> {
  if (!isValidCuit(cuit)) {
    throw new PayerCuitInvalidError(cuit);
  }

  const [row] = await db.select().from(ocrRows).where(eq(ocrRows.id, rowId));
  if (!row) throw new RowNotFoundError(rowId);

  // Only a flagged pre-emission row (CONFIDENT/BLOCKED) may have its payer
  // resolved. A FAILED row (crashed OCR) must stay FAILED — it needs a re-OCR,
  // not a CUIT assignment (C1).
  if (!RESOLVABLE_ROW_STATUSES.has(row.status)) {
    throw new RowNotResolvableError(
      `OCR row ${rowId} has status "${row.status}" — only CONFIDENT or BLOCKED rows may have a payer CUIT resolved`,
    );
  }

  // Refuse any row whose invoice is terminal/in-flight: a REJECTED or EMITTED
  // invoice must never be re-promoted to REVIEWED (C1).
  const [existingInvoice] = await db
    .select()
    .from(invoices)
    .where(eq(invoices.ocrRowId, rowId));
  if (existingInvoice && TERMINAL_INVOICE_STATUSES.has(existingInvoice.status)) {
    throw new RowNotResolvableError(
      `Invoice ${existingInvoice.id} has status "${existingInvoice.status}" — cannot resolve a payer on a ${existingInvoice.status} invoice`,
    );
  }

  // Teach the global registry (match by CBU/CVU/alias/name → update; else insert
  // with learnedFrom='manual'). `upsertPayer` throws on ambiguity (never guesses).
  const payer = await upsertPayer(db, {
    name: row.fields.name,
    cbu: row.fields.cbu,
    cvu: row.fields.cvu,
    alias: row.fields.alias,
    cuit,
  });

  // Record the CUIT on the row and mark it CORRECTED.
  await db
    .update(ocrRows)
    .set({ cuit, status: "CORRECTED" })
    .where(eq(ocrRows.id, rowId));

  // CORRECTED ⇒ REVIEWED via the existing status machine (no new transition).
  const invoice = await materializeInvoice(db, rowId);

  await writeAudit(db, {
    actor: "accountant",
    action: "payer.cuit_resolved",
    rowId,
    invoiceId: invoice.id,
    payload: { cuit, learnedFrom: payer.learnedFrom, inserted: payer.inserted },
  });

  return {
    rowId,
    status: "CORRECTED",
    invoiceId: invoice.id,
    invoiceStatus: invoice.status,
    learnedFrom: payer.learnedFrom,
    inserted: payer.inserted,
  };
}
