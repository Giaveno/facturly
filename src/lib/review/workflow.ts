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
 * Mapping (pure in `@/domain/emission`, applied at materialization):
 *   BLOCKED (ocr_row)   ⇒ invoice stays PENDING
 *   CORRECTED (ocr_row) ⇒ invoice becomes REVIEWED
 */

import { eq } from "drizzle-orm";
import {
  batches,
  clients,
  invoices,
  ocrRows,
  photos,
} from "@/lib/db/schema";
import { invoiceStatusForRow } from "@/domain/emission";
import {
  cbteTipo,
  RECEPTOR_DOC_TIPO_CUIT,
  type CondicionIVA,
} from "@/domain/policy";
import { condicionIvaToReceptorId } from "@/adapters/arca/padron";
import { deriveAmounts } from "@/domain/amounts";
import { isValidCuit } from "@/domain/cuit";
import { writeAudit } from "@/lib/audit/audit";
import type { Db } from "@/lib/db/types";
import type { ArcaGateway } from "@/ports/arca-gateway";

/** Thrown when a transition is illegal (e.g. approving a non-REVIEWED invoice). */
export class InvoiceStateError extends Error {
  readonly invoiceId: string;
  readonly status: string;

  constructor(invoiceId: string, status: string, action: string, reason: string) {
    super(`Cannot ${action} invoice ${invoiceId} (status "${status}"): ${reason}`);
    this.name = "InvoiceStateError";
    this.invoiceId = invoiceId;
    this.status = status;
  }
}

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

/**
 * Materializes (or re-syncs) the invoice for an OCR row. Idempotent: repeated
 * calls return the existing row and re-derive its status from the row status,
 * so a BLOCKED row stays PENDING and a later CORRECTED row promotes its invoice
 * to REVIEWED.
 */
export async function materializeInvoice(
  db: Db,
  rowId: string,
): Promise<{ id: string; status: string }> {
  const [existing] = await db
    .select()
    .from(invoices)
    .where(eq(invoices.ocrRowId, rowId));

  const [row] = await db.select().from(ocrRows).where(eq(ocrRows.id, rowId));
  if (!row) throw new Error(`materializeInvoice: no OCR row ${rowId}`);
  const derived = invoiceStatusForRow(row.status);

  if (existing) {
    if (existing.status !== derived) {
      await db
        .update(invoices)
        .set({ status: derived })
        .where(eq(invoices.id, existing.id));
    }
    return { id: existing.id, status: derived };
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
export async function markInvoiceReviewed(
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
  await db
    .update(invoices)
    .set({ status: "REVIEWED" })
    .where(eq(invoices.id, invoiceId));
  return { id: invoiceId, status: "REVIEWED" };
}

/**
 * REVIEWED → APPROVED. Resolves the comprobante type and receptor from the
 * payer's IVA condition (Padrón A5 via the gateway) and derives the net/IVA
 * amounts. Fails loudly when the payer condition is unresolved (never silently
 * downgrades to Consumidor Final) or when the invoice is not REVIEWED.
 */
export async function approveInvoice(
  db: Db,
  gateway: ArcaGateway,
  invoiceId: string,
  clock: Clock = () => new Date(),
): Promise<typeof invoices.$inferSelect> {
  const { invoice, row, client } = await loadInvoiceContext(db, invoiceId);
  if (invoice.status !== "REVIEWED") {
    throw new InvoiceStateError(
      invoiceId,
      invoice.status,
      "approve",
      "only REVIEWED invoices may be approved",
    );
  }

  const payerCuit = row.cuit && isValidCuit(row.cuit) ? row.cuit : null;

  let condicion: CondicionIVA | "unresolved";
  let receptorDocTipo: number;
  let receptorDocNro: number;
  let condicionIvaReceptorId: number;
  if (payerCuit) {
    condicion = await gateway.getIvaCondition(client.cuit, payerCuit);
    if (condicion === "unresolved") {
      await writeAudit(db, {
        actor: "system",
        action: "invoice.flagged_review",
        invoiceId,
        rowId: row.id,
        payload: { reason: "unresolved Padrón A5 condition", payerCuit },
      });
      throw new InvoiceStateError(
        invoiceId,
        invoice.status,
        "approve",
        `payer CUIT ${payerCuit} has no Padrón A5 condition — flag for review`,
      );
    }
    // DocTipo is the RECEPTOR DOCUMENT TYPE (80 = CUIT), NOT the IVA condition
    // id. The condition travels separately as `CondicionIVAReceptorId` (C1).
    receptorDocTipo = RECEPTOR_DOC_TIPO_CUIT;
    receptorDocNro = Number(payerCuit);
    condicionIvaReceptorId = condicionIvaToReceptorId(condicion);
  } else {
    // W1: no valid CUIT → flag for review. NEVER silently assume Consumidor
    // Final — a payer who is actually RI would get a wrong Factura B. The
    // registry read-side resolver (out of scope) is what would later confirm a
    // genuine Consumidor Final.
    await writeAudit(db, {
      actor: "system",
      action: "invoice.flagged_review",
      invoiceId,
      rowId: row.id,
      payload: { reason: "missing or invalid payer CUIT" },
    });
    throw new InvoiceStateError(
      invoiceId,
      invoice.status,
      "approve",
      "payer CUIT is missing or invalid — flag for review (never assume Consumidor Final)",
    );
  }

  const decision = cbteTipo(client.condicionIva, condicion);
  const total = invoice.importeTotalCentavos ?? row.fields.amount;
  const amounts = deriveAmounts(total, decision.cbteTipo);
  const today = clock().toISOString().slice(0, 10);

  const [updated] = await db
    .update(invoices)
    .set({
      status: "APPROVED",
      cbteTipo: decision.cbteTipo,
      receptorDocTipo,
      receptorDocNro,
      condicionIvaReceptorId,
      receptorRazonSocial: row.fields.name,
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
      condicionIvaReceptorId,
      receptorDocTipo,
      receptorDocNro,
    },
  });
  return updated;
}

/**
 * PENDING/REVIEWED → REJECTED (non-sale discard). Requires a `discardReason`;
 * the row is soft-retained (never deleted) and can never be emitted.
 */
export async function rejectInvoice(
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
    throw new InvoiceStateError(
      invoiceId,
      invoice.status,
      "reject",
      "a discard reason is required",
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
