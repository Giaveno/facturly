/**
 * Padrón A5 (`ws_sr_constancia_inscripcion`) adapter — maps ARCA's "constancia
 * de inscripción" result to a normalized IVA condition (see the design's
 * CondicionIVA bridge).
 *
 * Mapping table (design):
 *   - `datosRegimenGeneral` present                     → `ri` (régimen general)
 *   - `datosMonotributo` present                        → `monotributista`
 *   - `impuestos` id 30 (IVA, regimen general)          → `ri`
 *   - `impuestos` 32/33/34 only, no IVA                 → `exento`
 *   - genuinely absent (no data, no error)              → `unresolved`
 *       → flagged for REVIEW, never assumed Consumidor Final.
 *   - `errorConstancia` / `errorMonotributo` present    → THROWS (lookup
 *       errored — must NOT silently become Consumidor Final / Factura B).
 *
 * The WSFEv1 receptor ID (1/6/4/5) mapping is exposed via
 * `condicionIvaToReceptorId` for the invoice-detail builder (slice 4). It THROWS
 * on `unresolved` rather than downgrading to Consumidor Final.
 */

import { XMLParser } from "fast-xml-parser";
import type { CondicionIVA } from "@/domain/policy";
import { ArcaBusinessError } from "./errors";
import { escapeXml } from "./xml";

/** Injectable HTTP transport (offline tests substitute a fake). */
export interface PadronTransport {
  post(url: string, body: string, headers: Record<string, string>): Promise<string>;
}

/** One `impuesto` entry from the A5 `impuestos` array. */
export interface PadronImpuesto {
  idImpuesto: string;
}

/** The subset of the A5 `personaReturn` the mapping needs. */
export interface PadronPersona {
  datosMonotributo?: unknown;
  datosRegimenGeneral?: unknown;
  impuestos?: PadronImpuesto[];
  errorConstancia?: string;
  errorMonotributo?: string;
}

const NAMESPACE = "http://a5.soap.ws.server.puc.sr/";

const XML_PARSER = () =>
  new XMLParser({
    removeNSPrefix: true,
    ignoreAttributes: true,
    parseTagValue: false,
    parseAttributeValue: false,
  });

const SOAP_HEADERS: Record<string, string> = {
  "Content-Type": "text/xml; charset=utf-8",
  SOAPAction: "",
};

function asArray<T>(x: T | T[] | undefined): T[] {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

/**
 * Maps a parsed A5 `personaReturn` to a normalized IVA condition.
 *
 * Precedence: monotributo > datosRegimenGeneral (ri) > impuestos 30 (ri) >
 * impuestos 32/33/34 (exento) > unresolved.
 *
 * A lookup ERROR (`errorConstancia`/`errorMonotributo`) THROWS — it is not a
 * condition and must never be downgraded to Consumidor Final.
 */
export function padronPersonaToCondicion(
  persona: PadronPersona,
): CondicionIVA | "unresolved" {
  const error = persona.errorConstancia ?? persona.errorMonotributo;
  if (error) {
    throw new ArcaBusinessError(`Padrón lookup errored: ${error}`);
  }

  const hasMonotributo =
    persona.datosMonotributo !== undefined && persona.datosMonotributo !== null;
  if (hasMonotributo) return "monotributista";

  const hasRegimenGeneral =
    persona.datosRegimenGeneral !== undefined &&
    persona.datosRegimenGeneral !== null;
  if (hasRegimenGeneral) return "ri";

  const ids = (persona.impuestos ?? []).map((i) => i.idImpuesto);
  if (ids.includes("30")) return "ri";
  if (ids.some((id) => id === "32" || id === "33" || id === "34")) {
    return "exento";
  }
  return "unresolved";
}

/**
 * The WSFEv1 receptor IVA ID for a normalized condition (design's ReceptorId
 * column). `unresolved` THROWS — the invoice-detail builder must flag the payer
 * for review, not silently emit a Consumidor Final invoice.
 */
export function condicionIvaToReceptorId(
  condicion: CondicionIVA | "unresolved",
): number {
  switch (condicion) {
    case "ri":
      return 1;
    case "monotributista":
      return 6;
    case "exento":
      return 4;
    case "consumidorFinal":
      return 5;
    case "unresolved":
      throw new ArcaBusinessError(
        "Cannot map an unresolved IVA condition to a receptor id — the payer must be flagged for review",
      );
  }
}

/** Builds the `getPersona` SOAP envelope for the A5 service. */
export function buildGetPersonaEnvelope(
  auth: { token: string; sign: string; cuitRepresentada: string },
  idPersona: string,
): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a5="${NAMESPACE}">` +
    "<soapenv:Header/>" +
    "<soapenv:Body>" +
    "<a5:getPersona>" +
    `<token>${auth.token}</token>` +
    `<sign>${auth.sign}</sign>` +
    `<cuitRepresentada>${escapeXml(auth.cuitRepresentada)}</cuitRepresentada>` +
    `<idPersona>${escapeXml(idPersona)}</idPersona>` +
    "</a5:getPersona>" +
    "</soapenv:Body>" +
    "</soapenv:Envelope>"
  );
}

/** Parses the A5 `getPersonaResponse` into the subset the mapping needs. */
export function parseGetPersonaResponse(soapXml: string): PadronPersona {
  const parsed = XML_PARSER().parse(soapXml) as {
    Envelope?: {
      Body?: {
        getPersonaResponse?: {
          personaReturn?: {
            datosMonotributo?: unknown;
            datosRegimenGeneral?: unknown;
            impuestos?: { impuesto?: unknown };
            errorConstancia?: unknown;
            errorMonotributo?: unknown;
          };
        };
      };
    };
  };
  const pr = parsed?.Envelope?.Body?.getPersonaResponse?.personaReturn;
  if (!pr) throw new Error("personaReturn not found in Padrón A5 response");

  const impuestos = asArray(pr.impuestos?.impuesto).map((imp) => {
    const o = imp as { idImpuesto?: unknown };
    return {
      idImpuesto: typeof o.idImpuesto === "string" ? o.idImpuesto : "",
    };
  });

  return {
    datosMonotributo: pr.datosMonotributo,
    datosRegimenGeneral: pr.datosRegimenGeneral,
    impuestos,
    errorConstancia:
      typeof pr.errorConstancia === "string" ? pr.errorConstancia : undefined,
    errorMonotributo:
      typeof pr.errorMonotributo === "string" ? pr.errorMonotributo : undefined,
  };
}

export interface PadronA5ClientOptions {
  url: string;
  transport: PadronTransport;
}

/** Padrón A5 client with injectable transport. */
export class PadronA5Client {
  private readonly url: string;
  private readonly transport: PadronTransport;

  constructor(options: PadronA5ClientOptions) {
    this.url = options.url;
    this.transport = options.transport;
  }

  async getPersona(
    token: string,
    sign: string,
    cuitRepresentada: string,
    idPersona: string,
  ): Promise<CondicionIVA | "unresolved"> {
    const body = buildGetPersonaEnvelope(
      { token, sign, cuitRepresentada },
      idPersona,
    );
    const response = await this.transport.post(this.url, body, SOAP_HEADERS);
    const persona = parseGetPersonaResponse(response);
    // Throws on errorConstancia/errorMonotributo (fail loud — never downgrade).
    return padronPersonaToCondicion(persona);
  }
}
