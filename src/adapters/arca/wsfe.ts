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

import { XMLParser } from "fast-xml-parser";
import { formatCentavos } from "@/domain/money";
import { escapeXml, validateMonId } from "./xml";

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

/** One IVA alícuota in the invoice detail (Factura A only). */
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
    `<ar:Token>${auth.token}</ar:Token>` +
    `<ar:Sign>${auth.sign}</ar:Sign>` +
    `<ar:Cuit>${auth.cuit}</ar:Cuit>` +
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
    `<ar:ImpIVA>${formatCentavos(req.impIvaCentavos)}</ar:ImpIVA>` +
    "<ar:ImpTrib>0.00</ar:ImpTrib>" +
    `<ar:FchVtoPago>${formatDateYyyyMmDd(req.fchVtoPago)}</ar:FchVtoPago>` +
    `<ar:MonId>${escapeXml(validateMonId(req.monId))}</ar:MonId>` +
    `<ar:MonCotiz>${req.monCotiz}</ar:MonCotiz>` +
    `<ar:Iva>${ivaItems}</ar:Iva>` +
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
  const parsed = XML_PARSER().parse(soapXml) as {
    Envelope?: {
      Body?: {
        FECAESolicitarResponse?: {
          FECAESolicitarResult?: {
            FeCabResp?: { Resultado?: unknown };
            FeDetResp?: { FECAEDetResponse?: unknown };
            Errors?: { Err?: unknown };
          };
        };
      };
    };
  };
  const result = parsed?.Envelope?.Body?.FECAESolicitarResponse
    ?.FECAESolicitarResult;
  const cabResultado = result?.FeCabResp?.Resultado;
  const detArr = asArray(result?.FeDetResp?.FECAEDetResponse);
  const det = detArr[0] as
    | {
        Resultado?: unknown;
        CbteDesde?: unknown;
        CAE?: unknown;
        CAEFchVto?: unknown;
        Observaciones?: { Obs?: unknown };
      }
    | undefined;

  return {
    resultado:
      typeof cabResultado === "string" ? cabResultado : "R",
    cae: typeof det?.CAE === "string" ? det.CAE : null,
    caeFchVto: typeof det?.CAEFchVto === "string" ? det.CAEFchVto : null,
    cbteNro: typeof det?.CbteDesde === "string" ? Number(det.CbteDesde) : null,
    observaciones: asArray(det?.Observaciones?.Obs).map(mapObs),
    errors: asArray(result?.Errors?.Err).map(mapObs),
  };
}

function mapObs(o: unknown): ArcaObservation {
  const x = o as { Code?: unknown; Msg?: unknown } | undefined;
  return {
    code: typeof x?.Code === "string" ? x.Code : "",
    msg: typeof x?.Msg === "string" ? x.Msg : "",
  };
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
  const parsed = XML_PARSER().parse(soapXml) as {
    Envelope?: {
      Body?: {
        FECompConsultarResponse?: {
          FECompConsultarResult?: {
            ResultGet?: {
              Resultado?: unknown;
              CodAutorizacion?: unknown;
              FchVto?: unknown;
              CbteDesde?: unknown;
            };
          };
        };
      };
    };
  };
  const rg = parsed?.Envelope?.Body?.FECompConsultarResponse
    ?.FECompConsultarResult?.ResultGet;
  return {
    resultado: typeof rg?.Resultado === "string" ? rg.Resultado : "R",
    cae: typeof rg?.CodAutorizacion === "string" ? rg.CodAutorizacion : null,
    caeFchVto: typeof rg?.FchVto === "string" ? rg.FchVto : null,
    cbteNro: typeof rg?.CbteDesde === "string" ? Number(rg.CbteDesde) : null,
  };
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
  const parsed = XML_PARSER().parse(soapXml) as {
    Envelope?: {
      Body?: {
        FECompUltimoAutorizadoResponse?: {
          FECompUltimoAutorizadoResult?: { CbteNro?: unknown };
        };
      };
    };
  };
  const cbteNro =
    parsed?.Envelope?.Body?.FECompUltimoAutorizadoResponse
      ?.FECompUltimoAutorizadoResult?.CbteNro;
  if (typeof cbteNro !== "string") {
    throw new Error("CbteNro not found in FECompUltimoAutorizado response");
  }
  return Number(cbteNro);
}

export interface WsfeClientOptions {
  url: string;
  transport: WsfeTransport;
}

/** WSFEv1 client with injectable transport. */
export class WsfeClient {
  private readonly url: string;
  private readonly transport: WsfeTransport;

  constructor(options: WsfeClientOptions) {
    this.url = options.url;
    this.transport = options.transport;
  }

  async solicitar(
    auth: WsfeAuth,
    req: FecaesolicitarRequest,
  ): Promise<FecaesolicitarResult> {
    const body = buildFecaesolicitarEnvelope(auth, req);
    const response = await this.transport.post(this.url, body, SOAP_HEADERS);
    return parseFecaesolicitarResponse(response);
  }

  async consultarComprobante(
    auth: WsfeAuth,
    req: { ptoVta: number; cbteTipo: number; cbteNro: number },
  ): Promise<FecompConsultarResult> {
    const body = buildFecompConsultarEnvelope(auth, req);
    const response = await this.transport.post(this.url, body, SOAP_HEADERS);
    return parseFecompConsultarResponse(response);
  }

  async ultimoAutorizado(
    auth: WsfeAuth,
    req: { ptoVta: number; cbteTipo: number },
  ): Promise<number> {
    const body = buildFecompUltimoAutorizadoEnvelope(auth, req);
    const response = await this.transport.post(this.url, body, SOAP_HEADERS);
    return parseFecompUltimoAutorizadoResponse(response);
  }
}
