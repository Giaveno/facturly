import type { ReviewInvoiceRow } from "@/lib/review/read-model";
import { CorrectionValidationError, validateCorrections } from "@/domain/receipt";
export const isEditable = (row: ReviewInvoiceRow) => ["PENDING","REVIEWED"].includes(row.invoiceStatus) && ["CONFIDENT","BLOCKED","CORRECTED"].includes(row.status);
export function reviewBlockReason(row: ReviewInvoiceRow): string | null {
 if (row.status === "PENDING") return "La extracción está en curso. La revisión se habilitará cuando termine.";
 if (row.failed || row.status === "FAILED") return "La extracción falló. Es necesario volver a procesar el archivo; el reintento todavía no está disponible en esta pantalla.";
 try { validateCorrections({...row.fields,cuit:row.cuit,recipientMode:row.recipientMode,taxRate:row.taxRate}); } catch (error) { return error instanceof CorrectionValidationError ? error.message : "No se pudieron validar los datos del comprobante."; }
 if (row.issuerCondition === "ri" && row.taxRate === null) return "Seleccione una alícuota de IVA para la operación gravada. Este flujo solo admite productos con una alícuota; no admite servicios, exenciones ni tasas mixtas.";
 if (!["ri","monotributista","exento"].includes(row.issuerCondition)) return "La condición del emisor no permite facturar.";
 return null;
}
export function statusLabel(row: ReviewInvoiceRow): string {
 const labels: Record<string,string> = {REVIEWED:"Revisado",APPROVED:"Aprobado · emisión pendiente",EMITTING:"En emisión",EMITTED:"Emitido",EMIT_ERROR:"Error de emisión",EMIT_FAILED:"Emisión rechazada",REJECTED:"Rechazado"};
 if (row.invoiceStatus !== "PENDING") return labels[row.invoiceStatus] ?? "Estado no disponible";
 if (row.failed) return "Extracción fallida";
 if (row.status === "PENDING") return "Extracción en curso";
 return "Pendiente de revisión";
}
