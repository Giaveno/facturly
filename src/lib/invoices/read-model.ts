/**
 * Invoices read-model — the queries behind the Invoices page and the PDF
 * download route.
 *
 * `listIssuedInvoices` lists every issued-invoice row (join → invoice → client).
 * `loadIssuedInvoicePdfInput` maps one issued invoice to the `InvoicePdfInput`
 * the PDF renderer needs, and is the enforcement point for the "a NULL-CAE
 * reservation is NOT a downloadable invoice" rule: it returns `null` unless the
 * invoice has a real CAE (and is otherwise fully materialized).
 */

import { eq, isNotNull } from "drizzle-orm";
import { clients, invoices, issuedInvoices } from "@/lib/db/schema";
import type { InvoicePdfInput } from "@/pdf/render";
import type { CbteTipo } from "@/domain/policy";
import type { Db } from "@/lib/db/types";

/** One row of the Invoices page. */
export interface IssuedInvoiceRow {
  invoiceId: string;
  status: string;
  razonSocial: string;
  cbteTipo: number | null;
  cbteNro: number | null;
  cae: string | null;
  importeTotalCentavos: number | null;
}

/**
 * Lists genuinely issued invoices — only rows that actually have a CAE. A
 * NULL-CAE reservation (emission in flight, or stuck in EMIT_ERROR) is NOT an
 * issued invoice and MUST NOT appear here; it belongs to a different surface
 * (or nowhere), never silently presented as issued.
 */
export async function listIssuedInvoices(db: Db): Promise<IssuedInvoiceRow[]> {
  return db
    .select({
      invoiceId: invoices.id,
      status: invoices.status,
      razonSocial: clients.razonSocial,
      cbteTipo: invoices.cbteTipo,
      cbteNro: issuedInvoices.cbteNro,
      cae: issuedInvoices.cae,
      importeTotalCentavos: invoices.importeTotalCentavos,
    })
    .from(issuedInvoices)
    .innerJoin(invoices, eq(issuedInvoices.invoiceId, invoices.id))
    .innerJoin(clients, eq(invoices.clientId, clients.id))
    .where(isNotNull(issuedInvoices.cae))
    .orderBy(issuedInvoices.createdAt);
}

/**
 * Builds the PDF input for one issued invoice, or `null` when the invoice is
 * NOT downloadable. A NULL-CAE reservation (emission in flight / stuck) is NOT
 * an issued invoice and MUST be refused with an opaque response — so this
 * returns `null` unless the CAE (and every other field the renderer needs) is
 * present.
 */
export async function loadIssuedInvoicePdfInput(
  db: Db,
  invoiceId: string,
): Promise<InvoicePdfInput | null> {
  const [row] = await db
    .select({
      // Reservation pins the issuer fiscal tuple, including for legacy rows.
      cuit: issuedInvoices.cuit,
      ptoVta: issuedInvoices.ptoVta,
      cbteTipo: invoices.cbteTipo,
      cbteNro: issuedInvoices.cbteNro,
      cae: issuedInvoices.cae,
      caeFchVto: issuedInvoices.caeFchVto,
      fechaEmision: invoices.fechaEmision,
      importeTotal: invoices.importeTotalCentavos,
      moneda: invoices.moneda,
      receptorDocTipo: invoices.receptorDocTipo,
      receptorDocNro: invoices.receptorDocNro,
      condicionIvaReceptorId: invoices.condicionIvaReceptorId,
      receptorRazonSocial: invoices.receptorRazonSocial,
      approvalSnapshot: invoices.approvalSnapshot,
    })
    .from(issuedInvoices)
    .innerJoin(invoices, eq(issuedInvoices.invoiceId, invoices.id))
    .innerJoin(clients, eq(invoices.clientId, clients.id))
    .where(eq(issuedInvoices.invoiceId, invoiceId));

  if (!row) return null;

  // A NULL CAE is a reservation, NOT an issued invoice → refuse.
  if (!row.cae || !row.caeFchVto) return null;

  const required = {
    cuit: row.cuit,
    ptoVta: row.ptoVta,
    cbteTipo: row.cbteTipo,
    cbteNro: row.cbteNro,
    fechaEmision: row.fechaEmision,
    importeTotal: row.importeTotal,
    moneda: row.moneda,
    receptorDocTipo: row.receptorDocTipo,
    receptorDocNro: row.receptorDocNro,
    condicionIvaReceptorId: row.condicionIvaReceptorId,
    receptorRazonSocial: row.receptorRazonSocial,
  };
  if (Object.values(required).some((v) => v == null)) return null;

  return {
    cuit: row.cuit!,
    ptoVta: row.ptoVta!,
    cbteTipo: row.cbteTipo! as CbteTipo,
    cbteNro: row.cbteNro!,
    cae: row.cae,
    caeFchVto: row.caeFchVto,
    fechaEmision: row.fechaEmision!,
    importeTotal: row.importeTotal!,
    moneda: row.moneda!,
    receptorDocTipo: row.receptorDocTipo!,
    receptorDocNro: row.receptorDocNro!,
    condicionIvaReceptorId: row.condicionIvaReceptorId!,
    receptorRazonSocial: row.receptorRazonSocial!,
    environment: row.approvalSnapshot?.environment,
  };
}
