import { fiscalDate } from "@/domain/fiscal-date";
/**
 * Review workflow — the SERVER-SIDE invoice status machine.
 *
 * The `invoices.status` pgEnum declares the states; this module owns the legal
 * transitions and is the single enforcement point (the review UI's disabled
 * button is a hint, never enforcement):
 *
 *   PENDING → REVIEWED → APPROVED → EMITTING → EMITTED
 *   PENDING → REJECTED (discardReason, soft-retained, never emittable)
 *   EMITTING → EMIT_ERROR  (owned by the emission service, slice 4)
 *
 * Saving CORRECTED data leaves the invoice PENDING. Review confirmation is an
 * explicit, validated accountant action; page reads cannot confirm it.
 */

import { eq } from "drizzle-orm";
import {
  batches,
  clients,
  invoices,
  ocrRows,
  photos,
} from "@/lib/db/schema";
import { withRowLock, withInvoiceLock } from "./locks";
import { createApprovalSnapshot, matchesApprovalSnapshot, type ApprovalSnapshot } from "@/domain/approval-snapshot";
import { resolveArcaEnvironment } from "@/lib/emission/environment";
import { CorrectionValidationError, validateCorrections } from "@/domain/receipt";
import { invoiceStatusForRow } from "@/domain/emission";
import {
  cbteTipo,
  type CondicionIVA,
} from "@/domain/policy";
import { buildReviewFiscalData } from "@/domain/review-fiscal-data";
import { isValidCuit } from "@/domain/cuit";
import { writeAudit } from "@/lib/audit/audit";
import type { Db } from "@/lib/db/types";
import type { ArcaGateway } from "@/ports/arca-gateway";

/** Thrown when a transition is illegal (e.g. approving a non-REVIEWED invoice). */
export class InvoiceStateError extends Error {
  /** Only fixed application-owned guidance may cross the HTTP boundary. */
  publicMessage?: string;
  readonly invoiceId: string;
  readonly status: string;

  constructor(invoiceId: string, status: string, action: string, reason: string) {
    super(`Cannot ${action} invoice ${invoiceId} (status "${status}"): ${reason}`);
    this.name = "InvoiceStateError";
    this.invoiceId = invoiceId;
    this.status = status;
  }
}

export class ReviewRowNotFoundError extends Error {}

/** Internal marker: persist the failed lookup audit after transaction rollback. */
class UnresolvedPayerConditionError extends InvoiceStateError {}

/** Thrown when a discard reason is missing or over-length (mapped to 400). */
export class DiscardReasonError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "DiscardReasonError";
  }
}

/** Upper bound for the discard reason (it lands in `discard_reason` + audit). */
export const MAX_DISCARD_REASON_LENGTH = 500;

/** A clock returning the current instant (injectable for determinism). */
export type Clock = () => Date;

export interface InvoiceContext {
  invoice: typeof invoices.$inferSelect;
  row: typeof ocrRows.$inferSelect;
  client: typeof clients.$inferSelect;
}

/** Loads an invoice with its OCR row and client (the approval/emission inputs). */
export async function loadInvoiceContext(
  db: Db,
  invoiceId: string,
): Promise<InvoiceContext> {
  const [invoice] = await db
    .select()
    .from(invoices)
    .where(eq(invoices.id, invoiceId));
  if (!invoice) throw new Error(`No invoice with id ${invoiceId}`);

  const [row] = await db
    .select()
    .from(ocrRows)
    .where(eq(ocrRows.id, invoice.ocrRowId));
  if (!row) throw new Error(`No OCR row for invoice ${invoiceId}`);

  const [client] = await db
    .select()
    .from(clients)
    .where(eq(clients.id, invoice.clientId));
  if (!client) throw new Error(`No client for invoice ${invoiceId}`);

  return { invoice, row, client };
}

/** Resolves the client owning an OCR row (photo → batch → client). */
async function clientForRow(db: Db, rowId: string) {
  const [row] = await db.select().from(ocrRows).where(eq(ocrRows.id, rowId));
  if (!row) throw new Error(`No OCR row with id ${rowId}`);
  const [photo] = await db
    .select()
    .from(photos)
    .where(eq(photos.id, row.photoId));
  if (!photo) throw new Error(`No photo for OCR row ${rowId}`);
  const [batch] = await db
    .select()
    .from(batches)
    .where(eq(batches.id, photo.batchId));
  if (!batch) throw new Error(`No batch for photo ${photo.id}`);
  return batch.clientId;
}

/** Creates a missing PENDING invoice; existing lifecycle state is never changed by a read. */
async function materializeInvoiceLocked(
  db: Db,
  rowId: string,
): Promise<{ id: string; status: string }> {
  const [existing] = await db
    .select()
    .from(invoices)
    .where(eq(invoices.ocrRowId, rowId));

  const [row] = await db.select().from(ocrRows).where(eq(ocrRows.id, rowId));
  if (!row) throw new ReviewRowNotFoundError(`materializeInvoice: no OCR row ${rowId}`);
  const derived = invoiceStatusForRow(row.status);

  if (existing) {
    return { id: existing.id, status: existing.status };
  }

  const clientId = await clientForRow(db, rowId);
  const [invoice] = await db
    .insert(invoices)
    .values({
      ocrRowId: rowId,
      clientId,
      status: derived,
      importeTotalCentavos: row.fields.amount,
    })
    .returning();
  if (!invoice) throw new Error("materializeInvoice: insert returned no row");
  return { id: invoice.id, status: invoice.status };
}

/** PENDING → REVIEWED (the accountant confirms the extraction is correct). */
async function markInvoiceReviewedLocked(
  db: Db,
  invoiceId: string,
): Promise<{ id: string; status: string }> {
  const [invoice] = await db
    .select()
    .from(invoices)
    .where(eq(invoices.id, invoiceId));
  if (!invoice) throw new Error(`No invoice with id ${invoiceId}`);
  if (invoice.status !== "PENDING") {
    throw new InvoiceStateError(
      invoiceId,
      invoice.status,
      "review",
      "only PENDING invoices may be marked reviewed",
    );
  }
  const { row, client } = await loadInvoiceContext(db, invoiceId);
  assertReviewReady(invoiceId, row, client.condicionIva, true);
  // CORRECTED also represents explicit human validation of unchanged OCR data.
  // Preserve extraction scores and provenance; this is not a field correction.
  if (row.status === "BLOCKED") {
    await db.update(ocrRows).set({ status: "CORRECTED" }).where(eq(ocrRows.id, row.id));
  }
  await db
    .update(invoices)
    .set({ status: "REVIEWED", importeTotalCentavos: row.fields.amount })
    .where(eq(invoices.id, invoiceId));
  await writeAudit(db,{actor:"accountant",action:"invoice.reviewed",invoiceId,rowId:row.id,payload:{source:"manual_validation",previousRowStatus:row.status,fields:row.fields,cuit:row.cuit}});
  return { id: invoiceId, status: "REVIEWED" };
}

/**
 * REVIEWED → APPROVED. Resolves the comprobante type and receptor from the
 * explicit recipient mode (Padrón via the gateway only for identified CUIT)
 * and derives net/IVA. An unresolved identified recipient never silently
 * downgrades to Consumidor Final; anonymous CF is an intentional reviewed mode.
 */
async function approveInvoiceLocked(
  db: Db,
  gateway: ArcaGateway,
  invoiceId: string,
  clock: Clock = () => new Date(),
  expected?: ApprovalSnapshot,
  environment = resolveArcaEnvironment(process.env),
): Promise<typeof invoices.$inferSelect> {
  const { invoice, row, client } = await loadInvoiceContext(db, invoiceId);
  // Approval is a durable work decision, not a second fiscal state machine.
  // Re-delivery must retain the original fiscal date and immutable approval.
  if (invoice.status === "APPROVED") {
    const current = createApprovalSnapshot(row, client, environment);
    if (!invoice.approvalSnapshot || !matchesApprovalSnapshot(invoice.approvalSnapshot, current) || (expected && !matchesApprovalSnapshot(expected, current))) {
      throw new InvoiceStateError(invoiceId, invoice.status, "approve", "approved snapshot changed");
    }
    return invoice;
  }
  if (invoice.status !== "REVIEWED") {
    throw new InvoiceStateError(
      invoiceId,
      invoice.status,
      "approve",
      "only REVIEWED invoices may be approved",
    );
  }

  assertReviewReady(invoiceId, row, client.condicionIva);

  const approvalSnapshot = createApprovalSnapshot(row,client,environment);
  if (expected && !matchesApprovalSnapshot(expected,approvalSnapshot)) {
    throw new InvoiceStateError(invoiceId,invoice.status,"approve","displayed approval snapshot is stale; reload and confirm current values");
  }
  const payerCuit = row.recipientMode === "identified" && row.cuit && isValidCuit(row.cuit) ? row.cuit.replace(/[ -]/g, "") : null;

  let condicion: CondicionIVA | "unresolved";
  if (payerCuit) {
    try { condicion = await gateway.getIvaCondition(client.cuit, payerCuit); }
    catch {
      const error = new UnresolvedPayerConditionError(invoiceId,invoice.status,"approve","recipient IVA lookup failed");
      error.publicMessage = "No se pudo verificar la condición de IVA del CUIT en Padrón. La aprobación sigue bloqueada; vuelva a intentar la verificación.";
      throw error;
    }
    if (condicion === "unresolved") {
      const error = new UnresolvedPayerConditionError(
        invoiceId,
        invoice.status,
        "approve",
        `payer CUIT ${payerCuit} has no Padrón A5 condition — flag for review`,
      );
      error.publicMessage = "El CUIT no tiene una condición de IVA verificable en Padrón para este flujo. No se convirtió a Consumidor Final. Revise el CUIT o use otro sistema habilitado.";
      throw error;
    }
    // DocTipo is the RECEPTOR DOCUMENT TYPE (80 = CUIT), NOT the IVA condition
    // id. The condition travels separately as `CondicionIVAReceptorId` (C1).
  } else {
    // Explicit anonymous mode only; readiness rejects missing identified CUIT.
    condicion = "consumidorFinal";
  }

  const decision = cbteTipo(client.condicionIva, condicion);
  const fiscal = buildReviewFiscalData({ ...row, issuerCondition: client.condicionIva }, condicion);
  const amounts = fiscal.amounts;
  const today = fiscalDate(clock());

  const [updated] = await db
    .update(invoices)
    .set({
      status: "APPROVED",
      approvalSnapshot,
      cbteTipo: decision.cbteTipo,
      receptorDocTipo: fiscal.receptorDocTipo,
      receptorDocNro: fiscal.receptorDocNro,
      condicionIvaReceptorId: fiscal.condicionIvaReceptorId,
      receptorRazonSocial: fiscal.receptorRazonSocial,
      taxRate: decision.cbteTipo === 11 ? null : row.taxRate,
      fechaEmision: today,
      fechaVto: today,
      moneda: "PES",
      cotizacion: 1,
      importeNetoCentavos: amounts.net,
      importeIvaCentavos: amounts.iva,
      importeTotalCentavos: amounts.total,
    })
    .where(eq(invoices.id, invoiceId))
    .returning();
  if (!updated) throw new Error("approveInvoice: update returned no row");

  await writeAudit(db, {
    actor: "system",
    action: "invoice.approved",
    invoiceId,
    rowId: row.id,
    payload: {
      clientCuit: client.cuit,
      cbteTipo: decision.cbteTipo,
      condicionIvaReceptorId: fiscal.condicionIvaReceptorId,
      receptorDocTipo: fiscal.receptorDocTipo,
      receptorDocNro: fiscal.receptorDocNro,
    },
  });
  return updated;
}

/**
 * PENDING/REVIEWED → REJECTED (non-sale discard). Requires a `discardReason`;
 * the row is soft-retained (never deleted) and can never be emitted.
 */
async function rejectInvoiceLocked(
  db: Db,
  invoiceId: string,
  reason: string,
): Promise<{ id: string; status: string; discardReason: string }> {
  const [invoice] = await db
    .select()
    .from(invoices)
    .where(eq(invoices.id, invoiceId));
  if (!invoice) throw new Error(`No invoice with id ${invoiceId}`);

  if (invoice.status === "REJECTED") {
    return {
      id: invoiceId,
      status: "REJECTED",
      discardReason: invoice.discardReason ?? "",
    };
  }
  if (invoice.status !== "PENDING" && invoice.status !== "REVIEWED") {
    throw new InvoiceStateError(
      invoiceId,
      invoice.status,
      "reject",
      "only PENDING or REVIEWED invoices may be discarded",
    );
  }
  const trimmed = reason.trim();
  if (trimmed === "") {
    throw new DiscardReasonError("a discard reason is required");
  }
  if (trimmed.length > MAX_DISCARD_REASON_LENGTH) {
    throw new DiscardReasonError(
      `discard reason must be ${MAX_DISCARD_REASON_LENGTH} characters or fewer`,
    );
  }

  await db
    .update(invoices)
    .set({ status: "REJECTED", discardReason: trimmed })
    .where(eq(invoices.id, invoiceId));

  await writeAudit(db, {
    actor: "system",
    action: "invoice.rejected",
    invoiceId,
    rowId: invoice.ocrRowId,
    payload: { reason: trimmed },
  });
  return { id: invoiceId, status: "REJECTED", discardReason: trimmed };
}

function assertReviewReady(invoiceId: string, row: typeof ocrRows.$inferSelect, issuerCondition: CondicionIVA, allowBlocked = false) {
 if (!["CONFIDENT","CORRECTED",...(allowBlocked ? ["BLOCKED"] : [])].includes(row.status)) throw new InvoiceStateError(invoiceId,row.status,"review","OCR is not ready");
 try { validateCorrections({...row.fields,cuit:row.cuit,recipientMode:row.recipientMode,taxRate:row.taxRate});
  if (issuerCondition === "ri" && row.taxRate === null) throw new CorrectionValidationError("Seleccione una al\u00edcuota de IVA para la operaci\u00f3n gravada. Este flujo solo admite productos con una al\u00edcuota; no admite servicios, exenciones ni tasas mixtas.");
  if (!["ri","monotributista","exento"].includes(issuerCondition)) throw new CorrectionValidationError("La condici\u00f3n del emisor no permite facturar."); }
 catch (error) {
  if (!(error instanceof CorrectionValidationError)) throw error;
  const stateError = new InvoiceStateError(invoiceId,row.status,"review",error.message);
  stateError.publicMessage = error.message;
  throw stateError;
 }
}
export function materializeInvoice(db: Db,rowId: string) { return withRowLock(db,rowId,tx=>materializeInvoiceLocked(tx,rowId)); }
export function markInvoiceReviewed(db: Db,id: string) { return withInvoiceLock(db,id,tx=>markInvoiceReviewedLocked(tx,id)); }
export async function approveInvoice(db: Db,gateway: ArcaGateway,id: string,clock: Clock = ()=>new Date(),expected?: ApprovalSnapshot,environment = resolveArcaEnvironment(process.env)) {
 try { return await withInvoiceLock(db,id,tx=>approveInvoiceLocked(tx,gateway,id,clock,expected,environment)); }
 catch (error) {
  if (error instanceof UnresolvedPayerConditionError) {
   const [invoice] = await db.select({rowId:invoices.ocrRowId}).from(invoices).where(eq(invoices.id,id));
   if (invoice) await withRowLock(db,invoice.rowId,async tx => {
    const [current] = await tx.select({id:invoices.id}).from(invoices).where(eq(invoices.id,id));
    if (current) await writeAudit(tx,{actor:"system",action:"invoice.flagged_review",invoiceId:id,rowId:invoice.rowId,payload:{reason:"unresolved registry IVA condition"}});
   });
  }
  throw error;
 }
}
export function rejectInvoice(db: Db,id: string,reason: string) { return withInvoiceLock(db,id,tx=>rejectInvoiceLocked(tx,id,reason)); }
