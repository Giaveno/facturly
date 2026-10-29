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

import { and, eq, isNotNull } from "drizzle-orm";
import { clients, comprobantes, invoices, issuedInvoices } from "@/lib/db/schema";
import type { ComprobantePdfInput, InvoicePdfInput } from "@/pdf/render";
import type { ComprobanteItem } from "@/domain/comprobantes";
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

/** Loads only an approved comprobante, with its issuer/company snapshot. */
export async function loadApprovedComprobantePdfInput(
  db: Db,
  id: string,
  expectedEmpresaId: string,
): Promise<ComprobantePdfInput | null> {
  const conditions = [eq(comprobantes.id, id), eq(comprobantes.estado, "aprobado" as const)];
  conditions.push(eq(comprobantes.empresaId, expectedEmpresaId));
  const [row] = await db.select({
    id: comprobantes.id, empresaId: comprobantes.empresaId, issuerName: clients.razonSocial,
    issuerCuit: comprobantes.emisorCuit, environment: comprobantes.ambiente, cbteTipo: comprobantes.cbteTipo,
    ptoVta: comprobantes.ptoVta, cbteNro: comprobantes.cbteNro, fecha: comprobantes.fecha,
    docTipo: comprobantes.docTipo, docNro: comprobantes.docNro, condicionIvaReceptor: comprobantes.condicionIvaReceptor,
    receptorRazonSocial: clients.razonSocial, neto: comprobantes.importeNetoCentavos,
    iva: comprobantes.importeIvaCentavos, exento: comprobantes.importeExentoCentavos,
    tributos: comprobantes.importeTributosCentavos, total: comprobantes.importeTotalCentavos,
    items: comprobantes.items, cae: comprobantes.cae, caeVto: comprobantes.caeVto,
  }).from(comprobantes).innerJoin(clients, eq(comprobantes.empresaId, clients.id)).where(and(...conditions));
  if (!row || !row.cae || !row.caeVto || row.cbteNro == null) return null;
  if ([row.neto, row.iva, row.exento, row.tributos, row.total, row.condicionIvaReceptor].some((v) => v == null)) return null;
  return {
    empresaId: row.empresaId, issuerName: row.issuerName, issuerCuit: row.issuerCuit,
    environment: row.environment, cbteTipo: row.cbteTipo as CbteTipo, ptoVta: row.ptoVta,
    cbteNro: row.cbteNro, fecha: row.fecha, docTipo: row.docTipo, docNro: row.docNro,
    // The comprobantes schema intentionally has no receptor name snapshot.
    // Never substitute the issuer name; use only an explicit safe fallback.
    receptorRazonSocial: row.docTipo === 99 ? "Consumidor Final" : `Documento ${row.docNro}`,
    condicionIvaReceptor: row.condicionIvaReceptor!,
    importeNetoCentavos: row.neto!, importeIvaCentavos: row.iva!, importeExentoCentavos: row.exento!,
    importeTributosCentavos: row.tributos!, importeTotalCentavos: row.total!,
    items: (Array.isArray(row.items) ? row.items : []) as ComprobanteItem[], cae: row.cae, caeVto: row.caeVto,
  };
}
