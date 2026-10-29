/**
 * Invoice PDF — RG 4892 QR + CAE + due date + conditional Ley 27.618 legend.
 *
 * The QR payload is built by `@/domain/qr` (reused, NOT re-implemented): the
 * URL is `https://www.arca.gob.ar/fe/qr/?p=<base64 json>` with the 13 fields,
 * RAW base64 (not URL-encoded) per the official RG 4892 spec.
 *
 * Two layers, so the content is pure-testable and pdf-lib is a thin renderer:
 *   - `buildInvoiceQrUrl` / `buildInvoicePdfModel` are PURE (13-field payload,
 *     text lines, legend flag). These are what the tests round-trip.
 *   - `renderInvoicePdf` draws the model with pdf-lib and encodes the QR via an
 *     injectable encoder (defaults to the `qrcode` PNG encoder).
 */

import { PDFDocument, StandardFonts } from "pdf-lib";
import QRCode from "qrcode";
import { buildQrUrl, type QrData } from "@/domain/qr";
import { formatCentavos, type Centavos } from "@/domain/money";
import { requiresLey27618Legend, type CbteTipo } from "@/domain/policy";

/**
 * The legal legend ARCA requires on a Factura A issued to a Monotributista.
 * NOTE: exact wording must be verified against RG 5003 / Ley 27.618 before
 * production — this is a faithful placeholder, not the verified legal text.
 */
export const LEY_27618_LEGEND =
  "Ley 27.618: el crédito fiscal discriminado en el presente comprobante sólo podrá " +
  "ser computado por el receptor en la medida que se encuentre inscripto como " +
  "Responsable Inscripto en el IVA.";

/** The data an issued invoice contributes to its PDF + QR. */
export interface InvoicePdfInput {
  /** Persisted approval environment only; never inferred from current config. */
  environment?: "production" | "homologacion";
  /** Emisor CUIT (11 digits, no separators). */
  cuit: string;
  ptoVta: number;
  cbteTipo: CbteTipo;
  cbteNro: number;
  /** 14-digit CAE. */
  cae: string;
  /** CAE expiry, YYYY-MM-DD. */
  caeFchVto: string;
  fechaEmision: string;
  importeTotal: Centavos;
  moneda: string;
  receptorDocTipo: number;
  receptorDocNro: number;
  /** Receptor IVA condition id (RG 5616) — drives the Ley 27.618 legend. */
  condicionIvaReceptorId: number;
  receptorRazonSocial: string;
}

/** Maps an issued invoice to the 13-field RG 4892 payload (via @/domain/qr). */
export function buildInvoiceQrData(input: InvoicePdfInput): QrData {
  return {
    ver: 1,
    fecha: input.fechaEmision,
    cuit: Number(input.cuit),
    ptoVta: input.ptoVta,
    tipoCmp: input.cbteTipo,
    nroCmp: input.cbteNro,
    importe: input.importeTotal / 100,
    moneda: input.moneda,
    ctz: 1,
    tipoDocRec: input.receptorDocTipo,
    nroDocRec: input.receptorDocNro,
    tipoCodAut: "E",
    codAut: Number(input.cae),
  };
}

/** The full QR URL (RAW base64 payload) for an issued invoice. */
export function buildInvoiceQrUrl(input: InvoicePdfInput): string {
  return buildQrUrl(buildInvoiceQrData(input));
}

/** Pure PDF content model — what gets drawn, before any rendering. */
export interface PdfContentModel {
  homologacion?: boolean;
  qrUrl: string;
  lines: Array<{ label: string; value: string }>;
  includesLey27618Legend: boolean;
}

/** Builds the pure content model for an issued invoice. */
export function buildInvoicePdfModel(input: InvoicePdfInput): PdfContentModel {
  const legend = requiresLey27618Legend(input.cbteTipo, input.condicionIvaReceptorId);
  return {
    homologacion: input.environment === "homologacion",
    qrUrl: buildInvoiceQrUrl(input),
    lines: [
      { label: "Comprobante", value: String(input.cbteTipo) },
      { label: "Punto de Venta", value: String(input.ptoVta) },
      { label: "Número", value: String(input.cbteNro) },
      { label: "Fecha", value: input.fechaEmision },
      { label: "Receptor", value: input.receptorRazonSocial },
      { label: "Documento", value: input.receptorDocTipo === 99 ? "Sin identificar (99 / 0)" : `${input.receptorDocTipo === 80 ? "CUIT" : "Tipo " + input.receptorDocTipo} ${input.receptorDocNro}` },
      { label: "Importe", value: formatCentavos(input.importeTotal) },
      { label: "CAE", value: input.cae },
      { label: "CAE Vencimiento", value: input.caeFchVto },
    ],
    includesLey27618Legend: legend,
  };
}

/** Encodes a URL string into a PNG QR image (bytes). */
export type QrEncoder = (url: string) => Promise<Uint8Array>;

/** Default QR encoder: `qrcode` PNG. */
export async function encodeQrPng(url: string): Promise<Uint8Array> {
  const buf = await QRCode.toBuffer(url, {
    type: "png",
    errorCorrectionLevel: "M",
  });
  return new Uint8Array(buf);
}

/** Renders the content model to PDF bytes with an injectable QR encoder. */
export async function renderInvoicePdf(
  model: PdfContentModel,
  encodeQr: QrEncoder = encodeQrPng,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]); // A4 portrait
  const font = await doc.embedFont(StandardFonts.Helvetica);

  let y = 800;
  if (model.homologacion) {
    page.drawText("HOMOLOGACION - SIN VALIDEZ FISCAL", {x:50,y,size:16,font});
    y -= 30;
  }
  for (const line of model.lines) {
    page.drawText(`${line.label}: ${line.value}`, { x: 50, y, size: 11, font });
    y -= 20;
  }

  if (model.includesLey27618Legend) {
    page.drawText(LEY_27618_LEGEND, { x: 50, y: y - 4, size: 9, font });
    y -= 30;
  }

  const qrPng = await encodeQr(model.qrUrl);
  const qrImage = await doc.embedPng(qrPng);
  page.drawImage(qrImage, { x: 420, y: 740, width: 120, height: 120 });

  return doc.save();
}
