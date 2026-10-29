import { XMLParser, XMLValidator } from "fast-xml-parser";
import { ArcaQueryError, type PadronFaultReason } from "./query-diagnostics";
import { escapeXml } from "./xml";

export interface PadronLookupData {
  status: "found" | "not_found";
  condition: "ri" | "monotributista" | "exento" | "no-determinada";
  reason: "explicit_tax" | "no_supported_tax" | "ambiguous_data" | "not_found";
  razonSocial?: string;
}
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const array = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
function fail(category: "malformed-response" | "provider-errors" | "soap-fault" = "malformed-response"): never { throw new ArcaQueryError("padron", category); }

/** Public v4.1 WSDL declares this empty fault detail type, not numeric codes.
 * Never infer authentication/permissions from arbitrary provider fault strings.
 */
export function padronFaultReason(fault: unknown): PadronFaultReason {
  const detail = object(object(fault)?.detail);
  return detail && Object.hasOwn(detail, "SRValidationException") ? "validation-rejected" : "unclassified";
}

export function buildPadronLookupEnvelope(auth: { token: string; sign: string; cuitRepresentada: string }, targetCuit: string): string {
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a5="http://a5.soap.ws.server.puc.sr/">' +
    '<soapenv:Header/><soapenv:Body><a5:getPersona_v2>' +
    `<token>${escapeXml(auth.token)}</token><sign>${escapeXml(auth.sign)}</sign>` +
    `<cuitRepresentada>${escapeXml(auth.cuitRepresentada)}</cuitRepresentada><idPersona>${escapeXml(targetCuit)}</idPersona>` +
    '</a5:getPersona_v2></soapenv:Body></soapenv:Envelope>';
}

/** A5 documented nested taxes, not the legacy emission adapter's block-presence heuristic.
 * Only explicit AC registrations 20/30/32 are supported; contradictory data stays unresolved.
 */
export function parsePadronLookup(xml: string, targetCuit: string): PadronLookupData {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) fail();
  let parsed: Record<string, unknown> | undefined;
  try { parsed = object(new XMLParser({ removeNSPrefix: true, ignoreAttributes: true, parseTagValue: false }).parse(xml)); }
  catch { fail(); }
  const body = object(object(parsed?.Envelope)?.Body);
  if (body && "Fault" in body) throw new ArcaQueryError("padron", "soap-fault", { faultReason: padronFaultReason(body.Fault) });
  const person = object(object(body?.getPersona_v2Response)?.personaReturn);
  if (!person) fail();
  const general = object(person.datosGenerales);
  const errorKeys = ["errorConstancia", "errorMonotributo", "errorRegimenGeneral"];
  if (errorKeys.some(key => key in person)) {
    const error = object(person.errorConstancia);
    // Exact documented absence, never substring-match provider fault text.
    if (!general && !person.datosMonotributo && !person.datosRegimenGeneral && !person.errorMonotributo && !person.errorRegimenGeneral && error?.error === "No existe persona con ese Id" && error.idPersona === targetCuit) {
      return { status: "not_found", condition: "no-determinada", reason: "not_found" };
    }
    fail("provider-errors");
  }
  if (!general || general.idPersona !== targetCuit) fail();
  const safeName = (value: unknown) => typeof value === "string" && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : "";
  const razonSocial = safeName(general.razonSocial) || [safeName(general.apellido), safeName(general.nombre)].filter(Boolean).join(" ");
  const conditions = new Set<PadronLookupData["condition"]>();
  let ambiguous = (general.estadoClave !== undefined && general.estadoClave !== "ACTIVO") || (general.tipoClave !== undefined && general.tipoClave !== "CUIT");
  let unsupportedIva = false;
  for (const key of ["datosMonotributo", "datosRegimenGeneral"]) {
    if (!(key in person)) continue;
    const section = object(person[key]);
    if (!section) { ambiguous = true; continue; }
    for (const value of array(section.impuesto)) {
      const tax = object(value);
      if (!tax || typeof tax.idImpuesto !== "string" || !/^\d{1,9}$/.test(tax.idImpuesto)) { ambiguous = true; continue; }
      const id = tax.idImpuesto;
      if (!["20", "30", "32", "33", "34"].includes(id)) continue;
      if (tax.estadoImpuesto === "BA") continue;
      if (tax.estadoImpuesto !== "AC") { ambiguous = true; continue; }
      if (id === "33" || id === "34") { unsupportedIva = true; continue; }
      if ((id === "20") !== (key === "datosMonotributo")) { ambiguous = true; continue; }
      conditions.add(id === "20" ? "monotributista" : id === "30" ? "ri" : "exento");
    }
  }
  if (unsupportedIva && conditions.size > 0) ambiguous = true;
  return { status: "found", condition: !ambiguous && conditions.size === 1 ? [...conditions][0]! : "no-determinada", reason: ambiguous || conditions.size > 1 ? "ambiguous_data" : conditions.size === 1 ? "explicit_tax" : "no_supported_tax", ...(razonSocial ? { razonSocial } : {}) };
}
