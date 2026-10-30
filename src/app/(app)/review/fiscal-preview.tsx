import React from "react";
import type { ReviewInvoiceRow } from "@/lib/review/read-model";
import { buildReviewFiscalData } from "@/domain/review-fiscal-data";

const money = (value: number) => new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" }).format(value / 100);
const pending = "Pendiente de verificar en Padrón al aprobar";

/** Shows persisted review values, never unsaved client drafts or authentication data. */
export default function FiscalPreview({ row, environment }: { row: ReviewInvoiceRow; environment: "production" | "homologacion" }) {
  let fiscal: ReturnType<typeof buildReviewFiscalData>;
  try { fiscal = buildReviewFiscalData(row, null); }
  catch { return <section aria-label="Detalle para facturar"><h3>Detalle para facturar</h3><p>Faltan datos fiscales válidos. Corrija el comprobante y confirme nuevamente la revisión.</p></section>; }
  const fields: Array<[string, string | number]> = [
    ["Ambiente", environment === "homologacion" ? "Homologación: sin validez fiscal" : "Producción"],
    ["Empresa emisora", row.razonSocial], ["CUIT emisor", row.issuerCuit], ["Condición IVA emisor", row.issuerCondition],
    ["Punto de venta (PtoVta)", row.ptoVta],
    ["Tipo de comprobante (CbteTipo)", fiscal.cbteTipo === 1 ? "Factura A (001)" : fiscal.cbteTipo === 6 ? "Factura B (006)" : fiscal.cbteTipo === 11 ? "Factura C (011)" : pending],
    ["Concepto", "Productos (1)"], ["Cantidad de comprobantes (CantReg)", 1],
    ["Número (CbteDesde / CbteHasta)", "Se reserva al emitir; todavía no está asignado"],
    ["Receptor (referencia local)", fiscal.receptorRazonSocial],
    ["Tipo de documento (DocTipo)", fiscal.receptorDocTipo], ["Número de documento (DocNro)", fiscal.receptorDocNro],
    ["Condición IVA receptor (CondicionIVAReceptorId)", fiscal.condicionIvaReceptorId ?? pending],
    ["Fecha fiscal (CbteFch)", "Día UTC de la aprobación; no la fecha de la imagen"],
    ["Vencimiento de pago (FchVtoPago)", "No se envía para Productos (Concepto 1)"],
    ["Moneda (MonId)", "PES"], ["Cotización (MonCotiz)", 1],
    ["Neto (ImpNeto)", money(fiscal.amounts.net)], ["IVA (ImpIVA)", money(fiscal.amounts.iva)],
    ["No gravado (ImpTotConc)", money(0)], ["Exento (ImpOpEx)", money(0)], ["Tributos (ImpTrib)", money(0)],
    ["Total (ImpTotal)", money(fiscal.amounts.total)],
    ["Alícuota IVA", fiscal.cbteTipo === 11 ? "No corresponde: Factura C, sin IVA" : `${fiscal.taxRate}% · Id ${fiscal.taxRate === 10.5 ? 4 : fiscal.taxRate === 27 ? 6 : 5} · Base ${money(fiscal.amounts.net)} · Importe ${money(fiscal.amounts.iva)}`],
    ["Comprobantes asociados", "No se envían (factura nueva)"],
  ];
  return <section className="fiscal-preview" aria-label="Detalle para facturar"><h3>Detalle completo para facturar</h3>
    <p className="source-note">Datos guardados que usará la emisión. Los valores pendientes se resolverán al aprobar; no se consultó ARCA para mostrar este detalle.</p>
    <dl>{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <p className="source-note">Ítems: este flujo OCR no extrae ni envía un detalle de productos a WSFE; envía los importes globales indicados. El nombre del receptor es una referencia local, no un campo enviado a WSFE. No se envían períodos de servicio, opcionales ni compradores adicionales.</p>
  </section>;
}
