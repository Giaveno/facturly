import { parseDummyResponse, parseTiposCbteResponse } from "./wsfe-diagnostics";
/**
 * WSFEv1 SOAP client — `FECAESolicitar` (emission), `FECompConsultar` (the
 * idempotency re-fetch path), and `FECompUltimoAutorizado` (next comprobante
 * number).
 *
 * The HTTP/fetch transport is INJECTABLE (constructor param) so the request
 * building and response parsing are unit-tested OFFLINE against captured SOAP
 * envelopes — no network in the test suite.
 *
 * The `Auth` block carries `{ Token, Sign, Cuit }`. `Cuit` is the CLIENT
 * company CUIT per request (the delegation model): the accountant's certificate
 * signs one TA, and per-client delegation authorizes `wsfe` under `Auth.Cuit`.
 *
 * Amounts are integer centavos at this boundary (matching the domain); they are
 * rendered as 2-decimal strings in the SOAP body. Dates are rendered yyyyMMdd
 * (ARCA's WSFEv1 convention, distinct from WSAA's ISO form).
 */

import { parseIssuance, parseConsultation } from "./fiscal-response";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { ArcaQueryError } from "./query-diagnostics";
import { ArcaAuthError, ArcaBusinessError, ArcaTransientError, classifyFaultCode, safeEmissionError } from "./errors";
import { formatCentavos } from "@/domain/money";
import { escapeXml, validateMonId } from "./xml";
import type { FECAEReq } from "@/ports/arca-gateway";
import { deriveAmounts } from "@/domain/amounts";

/** WSFEv1 authentication header. */
export interface WsfeAuth {
  token: string;
  sign: string;
  cuit: string;
}

/** Injectable HTTP transport (offline tests substitute a fake). */
export interface WsfeTransport {
  post(url: string, body: string, headers: Record<string, string>): Promise<string>;
}

/** One taxable IVA alícuota in an A or B invoice detail. */
export interface IvaAlicuota {
  /** AFIP alícuota id (5=21%, 4=10.5%, 3=0%, 6=27%, 8=5%, 9=2.5%). */
  id: number;
  baseImpCentavos: number;
  importeCentavos: number;
}

/** A single `FECAESolicitar` request (one comprobante). */
export interface FecaesolicitarRequest {
  ptoVta: number;
  cbteTipo: number;
  /** Comprobante number (CbteDesde = CbteHasta). */
  cbteNro: number;
  /** Concepto (1 = Productos, 2 = Servicios, 3 = Productos y Servicios). */
  concepto: number;
  docTipo: number;
  docNro: number;
  /**
   * Condición frente al IVA del receptor (RG 5616): 1 RI, 4 Exento, 5 CF,
   * 6 Monotributista. Serialized as `<ar:CondicionIVAReceptorId>`.
   */
  condicionIvaReceptorId: number;
  /** Emission date, YYYY-MM-DD. */
  cbteFch: string;
  impNetoCentavos: number;
  impIvaCentavos: number;
  impTotalCentavos: number;
  /** Due date, YYYY-MM-DD. */
  fchVtoPago: string;
  monId: string;
  monCotiz: number;
  iva: IvaAlicuota[];
}

/** An ARCA observation or error (code + message). */
export interface ArcaObservation {
  code: string;
  msg: string;
}

/** Parsed `FECAESolicitar` result. */
export interface FecaesolicitarResult {
  /** Explicit provider-errors-only response, not an invented A/R header. */
  providerErrorsOnly?: true;
  cuit?: string;
  ptoVta?: number;
  cbteTipo?: number;
  fechaEmision?: string;
  /** Cabecera/detalle Resultado: "A" (aceptado), "R" (rechazado), "P" (parcial). */
  resultado: string;
  /** 14-digit CAE, or null when rejected. */
  cae: string | null;
  /** CAE expiry, YYYY-MM-DD, or null. */
  caeFchVto: string | null;
  /** Comprobante number assigned by ARCA, or null. */
  cbteNro: number | null;
  observaciones: ArcaObservation[];
  errors: ArcaObservation[];
}

/** Parsed `FECompConsultar` result. */
export interface FecompConsultarResult {
  condicionIvaReceptorId?: number | null;
  concepto?: number | null;
  impTotConcCentavos?: number | null;
  impOpExCentavos?: number | null;
  impTribCentavos?: number | null;
  emissionType: "CAE" | "CAEA" | "unknown";
  ptoVta: number | null; cbteTipo: number | null;
  docTipo: number | null; docNro: number | null; fechaEmision: string | null;
  impTotalCentavos: number | null; impNetoCentavos: number | null; impIvaCentavos: number | null;
  moneda: string | null; cotizacion: number | null;
  resultado: string;
  cae: string | null;
  caeFchVto: string | null;
  cbteNro: number | null;
}

const NAMESPACE = "http://ar.gov.afip.dif.FEV1/";

const XML_PARSER = () =>
  new XMLParser({
    removeNSPrefix: true,
    ignoreAttributes: true,
    // Keep every value a string: the 14-digit CAE must never be coerced to a
    // lossy JS number, and error codes must stay strings.
    parseTagValue: false,
    parseAttributeValue: false,
  });

const SOAP_HEADERS: Record<string, string> = {
  "Content-Type": "text/xml; charset=utf-8",
  SOAPAction: "",
};

/** Renders "YYYY-MM-DD" as ARCA's yyyyMMdd form. */
export function formatDateYyyyMmDd(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`Invalid ISO date "${iso}"`);
  return `${m[1]}${m[2]}${m[3]}`;
}

function asArray<T>(x: T | T[] | undefined): T[] {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

function authBlock(auth: WsfeAuth): string {
  return (
    "<ar:Auth>" +
    `<ar:Token>${escapeXml(auth.token)}</ar:Token>` +
    `<ar:Sign>${escapeXml(auth.sign)}</ar:Sign>` +
    `<ar:Cuit>${escapeXml(auth.cuit)}</ar:Cuit>` +
    "</ar:Auth>"
  );
}

function envelope(operationBody: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="${NAMESPACE}">` +
    "<soapenv:Header/>" +
    "<soapenv:Body>" +
    operationBody +
    "</soapenv:Body>" +
    "</soapenv:Envelope>"
  );
}

/**
 * Maps the port's `FECAEReq` to a `FecaesolicitarRequest` — the SOAP-boundary
 * request shape. Single place for the field mapping so the emission gateway and
 * the cross-boundary tests share one source of truth (C1).
 *
 * A/B carry the explicitly selected single taxable rate (10.5/21/27%).
 * C carries no IVA array element at all (ARCA10071).
 */
export function fecaReqToSolicitar(req: FECAEReq): FecaesolicitarRequest {
  if (req.cbteTipo === 6 && ![10.5,21,27].includes(req.taxRate ?? -1)) throw new Error("Factura B requires an explicit supported taxable rate");
  if (req.cbteTipo === 11 && (req.importeIva !== 0 || req.importeNeto !== req.importeTotal)) throw new Error("Factura C cannot include IVA");
  const amounts = deriveAmounts(req.importeTotal, req.cbteTipo, req.taxRate);
  if (amounts.net !== req.importeNeto || amounts.iva !== req.importeIva) throw new Error("Invoice IVA amounts do not match the selected taxable rate");
  return {
    ptoVta: req.ptoVta,
    cbteTipo: req.cbteTipo,
    cbteNro: req.cbteNro,
    concepto: 1,
    docTipo: req.receptorDocTipo,
    docNro: req.receptorDocNro,
    condicionIvaReceptorId: req.condicionIvaReceptorId,
    cbteFch: req.fechaEmision,
    impNetoCentavos: req.importeNeto,
    impIvaCentavos: req.importeIva,
    impTotalCentavos: req.importeTotal,
    fchVtoPago: req.fechaVto,
    monId: req.moneda,
    monCotiz: req.cotizacion,
    iva:
      req.cbteTipo !== 11
        ? [
            {
                id: req.taxRate === 10.5 ? 4 : req.taxRate === 27 ? 6 : 5,
              baseImpCentavos: req.importeNeto,
              importeCentavos: req.importeIva,
            },
          ]
        : [],
  };
}

/** Builds the `FECAESolicitar` SOAP envelope. */
export function buildFecaesolicitarEnvelope(
  auth: WsfeAuth,
  req: FecaesolicitarRequest,
): string {
  const ivaItems = req.iva
    .map(
      (a) =>
        "<ar:AlicIva>" +
        `<ar:Id>${a.id}</ar:Id>` +
        `<ar:BaseImp>${formatCentavos(a.baseImpCentavos)}</ar:BaseImp>` +
        `<ar:Importe>${formatCentavos(a.importeCentavos)}</ar:Importe>` +
        "</ar:AlicIva>",
    )
    .join("");

  const body =
    "<ar:FECAESolicitar>" +
    authBlock(auth) +
    "<ar:FeCAEReq>" +
    "<ar:FeCabReq>" +
    "<ar:CantReg>1</ar:CantReg>" +
    `<ar:PtoVta>${req.ptoVta}</ar:PtoVta>` +
    `<ar:CbteTipo>${req.cbteTipo}</ar:CbteTipo>` +
    "</ar:FeCabReq>" +
    "<ar:FeDetReq>" +
    "<ar:FECAEDetRequest>" +
    `<ar:Concepto>${req.concepto}</ar:Concepto>` +
    `<ar:DocTipo>${req.docTipo}</ar:DocTipo>` +
    `<ar:DocNro>${req.docNro}</ar:DocNro>` +
    `<ar:CbteDesde>${req.cbteNro}</ar:CbteDesde>` +
    `<ar:CbteHasta>${req.cbteNro}</ar:CbteHasta>` +
    `<ar:CbteFch>${formatDateYyyyMmDd(req.cbteFch)}</ar:CbteFch>` +
    `<ar:ImpTotal>${formatCentavos(req.impTotalCentavos)}</ar:ImpTotal>` +
    // Conc/OpEx/Trib amounts are out of scope for v1 invoices (always zero).
    "<ar:ImpTotConc>0.00</ar:ImpTotConc>" +
    `<ar:ImpNeto>${formatCentavos(req.impNetoCentavos)}</ar:ImpNeto>` +
    "<ar:ImpOpEx>0.00</ar:ImpOpEx>" +
    "<ar:ImpTrib>0.00</ar:ImpTrib>" +
    `<ar:ImpIVA>${formatCentavos(req.impIvaCentavos)}</ar:ImpIVA>` +
    (req.concepto === 1 ? "" : `<ar:FchVtoPago>${formatDateYyyyMmDd(req.fchVtoPago)}</ar:FchVtoPago>`) +
    `<ar:MonId>${escapeXml(validateMonId(req.monId))}</ar:MonId>` +
    `<ar:MonCotiz>${req.monCotiz}</ar:MonCotiz>` +
    `<ar:CondicionIVAReceptorId>${req.condicionIvaReceptorId}</ar:CondicionIVAReceptorId>` +
    (req.cbteTipo === 11 ? "" : `<ar:Iva>${ivaItems}</ar:Iva>`) +
    "</ar:FECAEDetRequest>" +
    "</ar:FeDetReq>" +
    "</ar:FeCAEReq>" +
    "</ar:FECAESolicitar>";

  return envelope(body);
}

/** Parses the `FECAESolicitar` response into a typed result. */
export function parseFecaesolicitarResponse(
  soapXml: string,
): FecaesolicitarResult {
  return parseIssuance(soapXml);
}

/** Builds the `FECompConsultar` envelope (idempotency re-fetch). */
export function buildFecompConsultarEnvelope(
  auth: WsfeAuth,
  req: { ptoVta: number; cbteTipo: number; cbteNro: number },
): string {
  const body =
    "<ar:FECompConsultar>" +
    authBlock(auth) +
    "<ar:FeCompConsReq>" +
    `<ar:CbteTipo>${req.cbteTipo}</ar:CbteTipo>` +
    `<ar:CbteNro>${req.cbteNro}</ar:CbteNro>` +
    `<ar:PtoVta>${req.ptoVta}</ar:PtoVta>` +
    "</ar:FeCompConsReq>" +
    "</ar:FECompConsultar>";
  return envelope(body);
}

/** Parses the `FECompConsultar` response (uses CodAutorizacion/FchVto). */
export function parseFecompConsultarResponse(
  soapXml: string,
): FecompConsultarResult {
  return parseConsultation(soapXml);
}

/** Builds the `FECompUltimoAutorizado` envelope (next comprobante number). */
export function buildFecompUltimoAutorizadoEnvelope(
  auth: WsfeAuth,
  req: { ptoVta: number; cbteTipo: number },
): string {
  const body =
    "<ar:FECompUltimoAutorizado>" +
    authBlock(auth) +
    `<ar:PtoVta>${req.ptoVta}</ar:PtoVta>` +
    `<ar:CbteTipo>${req.cbteTipo}</ar:CbteTipo>` +
    "</ar:FECompUltimoAutorizado>";
  return envelope(body);
}

/** Parses the `FECompUltimoAutorizado` response into the last used number. */
export function parseFecompUltimoAutorizadoResponse(soapXml: string): number {
  const invalid = (): never => {
    throw new ArcaBusinessError("ARCA ultimo failed (malformed-response)", { stage: "ultimo", category: "malformed-response" });
  };
  const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    return value as Record<string, unknown>;
  };
  if (soapXml.length > 1_048_576 || /<!DOCTYPE|<!ENTITY/i.test(soapXml) || XMLValidator.validate(soapXml) !== true) return invalid();
  const parsed = record(XML_PARSER().parse(soapXml));
  if (Object.keys(parsed).some(key => key !== "Envelope" && key !== "?xml")) return invalid();
  const body = record(record(parsed.Envelope).Body);
  if (body.Fault !== undefined) {
    const fault = record(body.Fault);
    const kind = classifyFaultCode(typeof fault.faultcode === "string" ? fault.faultcode : undefined);
    const details = { stage: "ultimo" as const, category: "soap-fault" as const };
    const message = "ARCA ultimo failed (soap-fault)";
    if (kind === "auth") throw new ArcaAuthError(message, details);
    if (kind === "transient") throw new ArcaTransientError(message, details);
    throw new ArcaBusinessError(message, details);
  }
  const result = record(record(body.FECompUltimoAutorizadoResponse).FECompUltimoAutorizadoResult);
  if (result.Errors !== undefined && result.Errors !== "") {
    const errors = asArray(record(result.Errors).Err);
    if (errors.length === 0 || errors.length > 100) return invalid();
    const codes = errors.map(error => record(error).Code);
    if (codes.some(code => typeof code !== "string" || !/^\d{1,9}$/.test(code))) return invalid();
    const providerCodes = codes.map(Number).slice(0, 10);
    // 601 is missing representation permission; refreshing a token cannot grant it.
    // Any business error wins over auth/infra; no Errors payload authorizes a number.
    const business = codes.find(code => !["500", "501", "502", "600"].includes(code as string));
    const auth = codes.find(code => code === "600");
    const code = (business ?? auth ?? codes[0]) as string;
    const details = { code, stage: "ultimo" as const, category: "provider-errors" as const, providerCodes };
    const message = `ARCA ultimo failed (provider-errors, code=${code})`;
    if (business) throw new ArcaBusinessError(message, details);
    if (auth) throw new ArcaAuthError(message, details);
    throw new ArcaTransientError(message, details);
  }
  const cbteNro = result.CbteNro;
  if (typeof cbteNro !== "string" || !/^\d{1,8}$/.test(cbteNro)) return invalid();
  return Number(cbteNro);
}

export interface WsfeClientOptions {
  url: string;
  transport: WsfeTransport;
}

export interface PointOfSale {
  number: number;
  emissionType: "CAE" | "CAEA" | "unknown";
  blocked: boolean | null;
  deregisteredOn: string | null;
  status: "available" | "blocked" | "deregistered" | "unknown";
}

/** Read-only query: Auth.Cuit is the represented company, not the certificate owner. */
export function buildFeParamGetPtosVentaEnvelope(auth: WsfeAuth): string {
  return envelope("<ar:FEParamGetPtosVenta>" +
    `<ar:Auth><ar:Token>${escapeXml(auth.token)}</ar:Token><ar:Sign>${escapeXml(auth.sign)}</ar:Sign><ar:Cuit>${escapeXml(auth.cuit)}</ar:Cuit></ar:Auth>` +
    "</ar:FEParamGetPtosVenta>");
}

/** Normalize only known protocol values; never return arbitrary provider text. */
export function parseFeParamGetPtosVentaResponse(xml: string): PointOfSale[] {
  const invalid = (): never => { throw new ArcaQueryError("wsfe", "malformed-response"); };
  const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    return value as Record<string, unknown>;
  };
  if (xml.length > 1_048_576 || /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) return invalid();
  const body = record(record(record(XML_PARSER().parse(xml)).Envelope).Body);
  if ("Fault" in body) throw new ArcaQueryError("wsfe", "soap-fault");
  const result = record(body.FEParamGetPtosVentaResponse).FEParamGetPtosVentaResult;
  if (result === "") return [];
  const data = record(result);
  if (data.Errors !== undefined && data.Errors !== "") {
    const errors = asArray(record(data.Errors).Err);
    const providerCodes = errors.slice(0, 100).flatMap(error => {
      const code = record(error).Code;
      return typeof code === "string" && /^\d{1,9}$/.test(code) ? [Number(code)] : [];
    });
    throw new ArcaQueryError("wsfe", "provider-errors", { providerCodes });
  }
  if (data.ResultGet === undefined || data.ResultGet === "") return [];
  const items = asArray(record(data.ResultGet).PtoVenta);
  if (items.length === 0 || items.length > 10_000) return invalid();
  const seen = new Set<number>();
  return items.map(item => {
    const p = record(item);
    if (typeof p.Nro !== "string" || !/^\d{1,5}$/.test(p.Nro)) return invalid();
    const number = Number(p.Nro);
    if (number < 1 || seen.has(number)) return invalid();
    seen.add(number);
    const emissionType = p.EmisionTipo === "CAE" || p.EmisionTipo === "CAEA" ? p.EmisionTipo : "unknown";
    const blocked = p.Bloqueado === "N" ? false : p.Bloqueado === "S" ? true : null;
    let deregisteredOn: string | null = null;
    let invalidDate = false;
    if (p.FchBaja !== undefined && p.FchBaja !== "") {
      if (typeof p.FchBaja === "string" && /^\d{8}$/.test(p.FchBaja)) {
        const iso = `${p.FchBaja.slice(0, 4)}-${p.FchBaja.slice(4, 6)}-${p.FchBaja.slice(6, 8)}`;
        const date = new Date(`${iso}T00:00:00Z`);
        if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso) deregisteredOn = iso;
        else invalidDate = true;
      } else invalidDate = true;
    }
    const status = deregisteredOn ? "deregistered" : blocked === true ? "blocked" :
      invalidDate || blocked === null || emissionType === "unknown" ? "unknown" : "available";
    return { number, emissionType, blocked, deregisteredOn, status };
  });
}

/** WSFEv1 client with injectable transport. */
export class WsfeClient {
  private readonly url: string;
  private readonly transport: WsfeTransport;

  constructor(options: WsfeClientOptions) {
    this.url = options.url;
    this.transport = options.transport;
  }

  async dummy() {
    return parseDummyResponse(await this.transport.post(this.url, envelope("<ar:FEDummy/>"), { ...SOAP_HEADERS, SOAPAction: `"${NAMESPACE}FEDummy"` }));
  }

  async getTiposCbte(auth: WsfeAuth) {
    const body = envelope("<ar:FEParamGetTiposCbte>" + authBlock(auth) + "</ar:FEParamGetTiposCbte>");
    return parseTiposCbteResponse(await this.transport.post(this.url, body, { ...SOAP_HEADERS, SOAPAction: `"${NAMESPACE}FEParamGetTiposCbte"` }));
  }

  async getPointsOfSale(auth: WsfeAuth): Promise<PointOfSale[]> {
    const response = await this.transport.post(this.url, buildFeParamGetPtosVentaEnvelope(auth), {
      ...SOAP_HEADERS, SOAPAction: `"${NAMESPACE}FEParamGetPtosVenta"`,
    });
    return parseFeParamGetPtosVentaResponse(response);
  }

  async solicitar(
    auth: WsfeAuth,
    req: FecaesolicitarRequest,
  ): Promise<FecaesolicitarResult> {
    const body = buildFecaesolicitarEnvelope(auth, req);
    try {
      const response = await this.transport.post(this.url, body, { ...SOAP_HEADERS, SOAPAction: `"${NAMESPACE}FECAESolicitar"` });
      const result = parseFecaesolicitarResponse(response);
      if (result.providerErrorsOnly) return result;
      if (result.cbteNro !== req.cbteNro || result.cuit !== auth.cuit || result.ptoVta !== req.ptoVta || result.cbteTipo !== req.cbteTipo || result.fechaEmision !== formatDateYyyyMmDd(req.cbteFch)) throw new ArcaBusinessError("ARCA issuance outcome uncertain (malformed-response)", { stage: "issuance", category: "malformed-response" });
      return result;
    } catch (error) { throw safeEmissionError(error, "issuance"); }
  }

  async consultarComprobante(
    auth: WsfeAuth,
    req: { ptoVta: number; cbteTipo: number; cbteNro: number },
  ): Promise<FecompConsultarResult> {
    const body = buildFecompConsultarEnvelope(auth, req);
    const response = await this.transport.post(this.url, body, { ...SOAP_HEADERS, SOAPAction: `"${NAMESPACE}FECompConsultar"` });
    return parseFecompConsultarResponse(response);
  }

  async ultimoAutorizado(
    auth: WsfeAuth,
    req: { ptoVta: number; cbteTipo: number },
  ): Promise<number> {
    const body = buildFecompUltimoAutorizadoEnvelope(auth, req);
    try {
      const response = await this.transport.post(this.url, body, {
        ...SOAP_HEADERS, SOAPAction: `"${NAMESPACE}FECompUltimoAutorizado"`,
      });
      return parseFecompUltimoAutorizadoResponse(response);
    } catch (err) {
      throw safeEmissionError(err, "ultimo");
    }
  }
}
