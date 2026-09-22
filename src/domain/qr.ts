/**
 * RG 4892 QR payload builder.
 *
 * Builds the base64 JSON payload that ARCA requires in the invoice QR, in the
 * URL form: https://www.arca.gob.ar/fe/qr/?p=<base64 json>.
 *
 * The payload carries EXACTLY 13 fields (see QrData). `importe` is the total
 * amount in INTEGER centavos — RG 4892 specifies the field as "Decimal up to
 * 13 integer digits and 2 decimals", which ARCA transmits as the integer value
 * with the two decimals implied (e.g. 12100 === $121.00). No floating point.
 */

export interface QrData {
  /** Format version (1). */
  ver: number;
  /** Emission date, RFC3339 full-date, e.g. "2020-10-13". */
  fecha: string;
  /** Emisor CUIT (11 digits). */
  cuit: number;
  /** Punto de venta. */
  ptoVta: number;
  /** Comprobante tipo (1|6|11 — see policy.ts). */
  tipoCmp: number;
  /** Comprobante number. */
  nroCmp: number;
  /** Total amount in integer centavos. */
  importe: number;
  /** 3-char currency code, e.g. "PES". */
  moneda: string;
  /** Exchange rate to ARS (1 when moneda is PES). */
  ctz: number;
  /** Receptor document type code (e.g. 80 CUIT, 99 consumidor final). */
  tipoDocRec: number;
  /** Receptor document number. */
  nroDocRec: number;
  /** "E" for CAE ("A" for CAEA is out of scope). */
  tipoCodAut: "E";
  /** 14-digit authorization code (CAE). */
  codAut: number;
}

/**
 * Official ARCA QR base URL (RG 4892, AFIP→ARCA rename).
 *
 * Source: RG 4892 "QR Especificaciones" — the invoice QR must resolve to
 * `https://www.arca.gob.ar/fe/qr/?p=<base64 json>`. The payload is RAW base64
 * (standard alphabet), NOT URL-encoded — ARCA decodes it as-is.
 */
export const QR_BASE_URL = "https://www.arca.gob.ar/fe/qr/?p=";

/**
 * UTF-8 safe, runtime-neutral base64 encode (no Node `Buffer`). The domain is
 * pure per the design, so it must not depend on the Node runtime; this works in
 * browsers, edge runtimes, and Node (TextEncoder + btoa are global in all).
 */
function encodeBase64Utf8(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** UTF-8 safe, runtime-neutral base64 decode (no Node `Buffer`). */
function decodeBase64Utf8(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

/** Serializes the payload to the JSON string encoded inside the QR. */
export function buildQrPayload(data: QrData): string {
  return JSON.stringify(data);
}

/** Builds the full QR URL (base64 JSON payload appended to the ARCA base URL). */
export function buildQrUrl(data: QrData): string {
  const json = buildQrPayload(data);
  const base64 = encodeBase64Utf8(json);
  return `${QR_BASE_URL}${base64}`;
}

/** Decodes a base64 payload back into QrData (used for round-trip verification). */
export function decodeQrPayload(base64: string): QrData {
  const json = decodeBase64Utf8(base64);
  return JSON.parse(json) as QrData;
}
