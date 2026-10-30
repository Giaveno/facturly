import { eq } from "drizzle-orm";
import { invoices, issuedInvoices } from "@/lib/db/schema";
import { loadInvoiceContext } from "@/lib/review/workflow";
import { assertRowEmittable } from "@/domain/emission";
import { createApprovalSnapshot, matchesApprovalSnapshot } from "@/domain/approval-snapshot";
import type { ComprobanteItem } from "@/domain/comprobantes";
import { assertEmissionConfiguration } from "@/adapters/arca/emissions";
import { emitComprobante, type ComprobanteEmissionDeps, type ComprobanteEmissionInput } from "./comprobante-emission-service";
import { resolveArcaEnvironment } from "./environment";
import { ArcaError, safeEmissionError } from "@/adapters/arca/errors";

export const reviewIdempotencyKey = (invoiceId: string) => `invoice:${invoiceId}:approve`;

/** Translate the immutable reviewed approval into the only fiscal service. */
export async function reviewEmissionInput(deps: ComprobanteEmissionDeps, invoiceId: string): Promise<ComprobanteEmissionInput> {
  const { invoice, row, client } = await loadInvoiceContext(deps.db, invoiceId);
  if (invoice.status !== "APPROVED") throw new Error("Solo se pueden emitir facturas de Revisión aprobadas.");
  assertRowEmittable(row.status);
  const configured = deps.environment ?? resolveArcaEnvironment(deps.env ?? process.env);

  const environment = configured === "produccion" ? "production" : configured;

  if (client.condicionIva === "consumidorFinal") throw new Error("Condición IVA del emisor inválida.");
  if (!invoice.approvalSnapshot || !matchesApprovalSnapshot(invoice.approvalSnapshot, createApprovalSnapshot(row, client, environment))) {
    throw new Error("La aprobación cambió; revise nuevamente los datos antes de emitir.");
  }
  const [historical] = await deps.db.select({ id: issuedInvoices.id }).from(issuedInvoices).where(eq(issuedInvoices.invoiceId, invoiceId));
  if (historical) throw new Error("La factura tiene una reserva histórica y no puede reenviarse a ARCA.");
  const { cbteTipo, receptorDocTipo, receptorDocNro, condicionIvaReceptorId, fechaEmision, importeNetoCentavos, importeIvaCentavos, importeTotalCentavos } = invoice;
  if (cbteTipo == null || receptorDocTipo == null || receptorDocNro == null || condicionIvaReceptorId == null || !fechaEmision || importeNetoCentavos == null || importeIvaCentavos == null || importeTotalCentavos == null) throw new Error("La aprobación no contiene todos los datos fiscales.");
  const fallback: ComprobanteItem = { descripcion: row.fields.name || "Comprobante revisado", netoCentavos: importeNetoCentavos, ivaCentavos: importeIvaCentavos, exentoCentavos: 0, tributosCentavos: 0, totalCentavos: importeTotalCentavos, alicuota: cbteTipo === 11 ? 0 : invoice.taxRate as ComprobanteItem["alicuota"] };
  const detailed: ComprobanteItem[] | undefined = invoice.approvalSnapshot.itemSnapshot ? JSON.parse(invoice.approvalSnapshot.itemSnapshot) : undefined;
  return {
    empresaId: client.id, idempotencyKey: reviewIdempotencyKey(invoiceId), emisorCuit: client.cuit, emisorCondicionIva: client.condicionIva,
    cbteTipo, ptoVta: client.ptoVta, concepto: 1, docTipo: receptorDocTipo, docNro: receptorDocNro,
    condicionIvaReceptor: condicionIvaReceptorId, fecha: fechaEmision,
    importeNetoCentavos, importeIvaCentavos, importeTotalCentavos, importeExentoCentavos: 0, importeTributosCentavos: 0,
    items: detailed?.length ? detailed : [fallback],
  };
}

export async function emitReviewedInvoice(deps: ComprobanteEmissionDeps, invoiceId: string) {
  assertEmissionConfiguration(deps.env ?? process.env);
  return emitComprobante(deps, await reviewEmissionInput(deps, invoiceId));
}

/** Failures retain the approved work item; retries always reuse its fiscal key. */
export async function emitReviewedBatch(deps: ComprobanteEmissionDeps, invoiceIds?: string[]) {
  assertEmissionConfiguration(deps.env ?? process.env);
  const ids = invoiceIds ?? (await deps.db.select({ id: invoices.id }).from(invoices).where(eq(invoices.status, "APPROVED"))).map(r => r.id);
  const outcomes: import("./emission-service").EmissionBatchResult[] = [];
  for (const invoiceId of ids) {
    try {
      const result = await emitReviewedInvoice(deps, invoiceId);
      outcomes.push({ invoiceId, outcome: result.estado === "aprobado" ? (result.emitted ? "emitted" : "already_emitted") : result.estado === "incierto" ? "failed_transient" : "failed_permanent", error: result.errores ?? undefined });
    } catch (error) {
      const diagnostic = error instanceof ArcaError ? safeEmissionError(error, error.stage ?? "issuance") : undefined;
      outcomes.push({ invoiceId, outcome: "failed_transient", error: diagnostic?.message ?? "No se pudo completar la emisiÃ³n; revise el comprobante antes de reintentar.", arcaCode: diagnostic?.code, stage: diagnostic?.stage, category: diagnostic?.category, providerCodes: diagnostic?.providerCodes, httpStatus: diagnostic?.httpStatus });
    }
  }
  return outcomes;
}


