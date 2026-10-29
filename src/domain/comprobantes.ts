import { isValidCuit } from "./cuit";

export type EmisorIvaCondition = "ri" | "monotributista" | "exento";
export type ComprobanteTaxRate = 0 | 10.5 | 21 | 27;

export interface ComprobanteItem {
  descripcion: string;
  netoCentavos: number;
  ivaCentavos: number;
  exentoCentavos: number;
  tributosCentavos: number;
  totalCentavos: number;
  alicuota: ComprobanteTaxRate;
}

export interface ComprobanteValidationInput {
  emisorCondicionIva?: EmisorIvaCondition;
  /** English alias used by the existing emission domain. */
  issuerCondition?: EmisorIvaCondition;
  cbteTipo: number;
  ptoVta: number;
  cbteNro?: number | null;
  concepto: number;
  docTipo: number;
  docNro: string | number;
  condicionIvaReceptor: number;
  fecha: string;
  importeNetoCentavos: number;
  importeIvaCentavos: number;
  importeExentoCentavos: number;
  importeTributosCentavos: number;
  importeTotalCentavos: number;
  items: ComprobanteItem[];
  observaciones?: string | null;
  errores?: string | null;
}

export interface ValidatedComprobante extends Omit<ComprobanteValidationInput, "issuerCondition" | "docNro" | "observaciones" | "errores"> {
  emisorCondicionIva: EmisorIvaCondition;
  docNro: string;
  observaciones?: string;
  errores?: string;
}

export class ComprobanteValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Comprobante inválido: ${issues.join("; ")}`);
    this.name = "ComprobanteValidationError";
    this.issues = issues;
  }
}

const TAX_RATES: readonly ComprobanteTaxRate[] = [0, 10.5, 21, 27];
const RECEPTOR_IVA_IDS = new Set([1, 4, 5, 6]);
const DOC_TYPES = new Set([80, 86, 87, 89, 90, 91, 92, 93, 94, 95, 96, 99]);

function isSafeCentavos(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function expectedIva(netoCentavos: number, alicuota: ComprobanteTaxRate): number {
  // Round half up using integer arithmetic (rate * 10 expresses tenths of a %).
  const numerator = BigInt(netoCentavos) * BigInt(Math.round(alicuota * 10));
  return Number((numerator + BigInt(500)) / BigInt(1000));
}

function validateDate(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

/** Removes secrets/control characters and bounds ARCA-provided text before persistence. */
export function sanitizeArcaText(value: string | null | undefined, maxLength = 300): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") return undefined;
  if (/[A-Za-z0-9+/_=-]{64,}/.test(value)) return "[REDACTED]";
  return value
    .replace(/-----BEGIN [^-]+-----[\s\S]*?(?:-----END [^-]+-----|$)/gi, "[REDACTED]")
    .replace(/\b(token|sign|password|secret|signature|cms|privatekey|cert(?:ificate)?)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[REDACTED]")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim()
    .slice(0, maxLength) || undefined;
}

function validateDocument(docTipo: number, docNro: string | number, issues: string[]): string {
  if (!DOC_TYPES.has(docTipo)) {
    issues.push("DocTipo no admitido");
  }
  const normalized = typeof docNro === "number"
    ? Number.isSafeInteger(docNro) && docNro >= 0 ? String(docNro) : ""
    : typeof docNro === "string" ? docNro.trim() : "";
  if (!/^\d+$/.test(normalized)) {
    issues.push("DocNro debe contener solo dígitos");
  } else if (docTipo === 99 && normalized !== "0") {
    issues.push("DocNro debe ser 0 para DocTipo 99");
  } else if ([80, 86, 87].includes(docTipo) && (normalized.length !== 11 || !isValidCuit(normalized))) {
    issues.push("DocNro no es un CUIT/CUIL válido");
  } else if (docTipo === 96 && (normalized.length < 7 || normalized.length > 8)) {
    issues.push("DocNro DNI debe tener entre 7 y 8 dígitos");
  }
  return normalized;
}

/**
 * Pure pre-emission validation. It performs no database or gateway calls and
 * returns a normalized value suitable for a later emission service.
 */
export function validateComprobante(input: ComprobanteValidationInput): ValidatedComprobante {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ComprobanteValidationError(["Los datos del comprobante no son válidos"]);
  }
  const issues: string[] = [];
  const emisorCondicionIva = input.emisorCondicionIva ?? input.issuerCondition;
  if (!emisorCondicionIva || !["ri", "monotributista", "exento"].includes(emisorCondicionIva)) {
    issues.push("La condición IVA del emisor no es válida");
  }
  if (![1, 6, 11].includes(input.cbteTipo)) issues.push("CbteTipo no admitido");
  if (emisorCondicionIva === "ri" && ![1, 6].includes(input.cbteTipo)) {
    issues.push("Un emisor RI solo puede emitir comprobantes A o B");
  }
  if (["monotributista", "exento"].includes(emisorCondicionIva ?? "") && input.cbteTipo !== 11) {
    issues.push("Un emisor monotributista o exento solo puede emitir comprobantes C");
  }
  if (!Number.isInteger(input.ptoVta) || input.ptoVta < 1 || input.ptoVta > 99999) issues.push("PtoVta no es válido");
  if (input.cbteNro != null && (!Number.isSafeInteger(input.cbteNro) || input.cbteNro < 1 || input.cbteNro > 9_999_999)) issues.push("CbteNro no es válido");
  if (![1, 2, 3].includes(input.concepto)) issues.push("Concepto no es válido");
  if (!RECEPTOR_IVA_IDS.has(input.condicionIvaReceptor)) issues.push("CondicionIVAReceptorId no es válida");
  if (!validateDate(input.fecha)) issues.push("Fecha no es válida");
  if (input.observaciones != null && typeof input.observaciones !== "string") issues.push("Observaciones ARCA no son válidas");
  if (input.errores != null && typeof input.errores !== "string") issues.push("Errores ARCA no son válidos");
  const docNro = validateDocument(input.docTipo, input.docNro, issues);
  if (input.docTipo === 99 && input.condicionIvaReceptor !== 5) issues.push("DocTipo 99 requiere CondicionIVAReceptorId 5");

  const amounts = [
    input.importeNetoCentavos,
    input.importeIvaCentavos,
    input.importeExentoCentavos,
    input.importeTributosCentavos,
    input.importeTotalCentavos,
  ];
  if (amounts.some((value) => !isSafeCentavos(value))) issues.push("Los importes deben ser centavos enteros no negativos");
  if (amounts.every((value) => isSafeCentavos(value)) &&
      input.importeTotalCentavos !== input.importeNetoCentavos + input.importeIvaCentavos + input.importeExentoCentavos + input.importeTributosCentavos) {
    issues.push("El importe total no coincide con neto + IVA + exento + tributos");
  }
  const items = Array.isArray(input.items) ? input.items : [];
  if (items.length === 0) {
    issues.push("Debe existir al menos un ítem");
  }
  let sums = [0, 0, 0, 0, 0];
  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      issues.push(`Ítem ${index + 1}: estructura no válida`);
      continue;
    }
    if (typeof item.descripcion !== "string" || !item.descripcion.trim() || item.descripcion.length > 500) issues.push(`Ítem ${index + 1}: descripción no válida`);
    if (![item.netoCentavos, item.ivaCentavos, item.exentoCentavos, item.tributosCentavos, item.totalCentavos].every(isSafeCentavos)) {
      issues.push(`Ítem ${index + 1}: importes inválidos`);
      continue;
    }
    const hasValidRate = (TAX_RATES as readonly number[]).includes(item.alicuota);
    if (!hasValidRate) issues.push(`Ítem ${index + 1}: alícuota no admitida`);
    if (input.cbteTipo === 11 && (item.ivaCentavos !== 0 || item.alicuota !== 0)) issues.push(`Ítem ${index + 1}: Factura C no puede discriminar IVA`);
    if (hasValidRate && item.alicuota === 0 && item.ivaCentavos !== 0) issues.push(`Ítem ${index + 1}: IVA debe ser cero sin alícuota`);
    if (hasValidRate && item.alicuota !== 0 && item.ivaCentavos !== expectedIva(item.netoCentavos, item.alicuota)) issues.push(`Ítem ${index + 1}: IVA incoherente con la alícuota`);
    if (item.totalCentavos !== item.netoCentavos + item.ivaCentavos + item.exentoCentavos + item.tributosCentavos) issues.push(`Ítem ${index + 1}: total incoherente`);
    const itemAmounts = [item.netoCentavos, item.ivaCentavos, item.exentoCentavos, item.tributosCentavos, item.totalCentavos];
    sums = sums.map((sum, amountIndex) => sum + itemAmounts[amountIndex]!);
  }
  if (items.length > 0 && sums.some((sum, index) => sum !== amounts[index])) issues.push("Los importes no coinciden con la suma de los ítems");

  if (issues.length > 0) throw new ComprobanteValidationError(issues);
  return {
    ...input,
    emisorCondicionIva: emisorCondicionIva!,
    docNro,
    observaciones: sanitizeArcaText(input.observaciones),
    errores: sanitizeArcaText(input.errores),
  };
}

/** Explicit name for callers that want to emphasize the gateway boundary. */
export const validateComprobanteBeforeEmission = validateComprobante;
