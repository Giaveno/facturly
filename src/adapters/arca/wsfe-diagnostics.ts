import { XMLParser, XMLValidator } from "fast-xml-parser";
import { ArcaQueryError } from "./query-diagnostics";

const invalid = (): never => { throw new ArcaQueryError("wsfe", "malformed-response"); };
const record = (v: unknown): Record<string, unknown> => !v || typeof v !== "object" || Array.isArray(v) ? invalid() : v as Record<string, unknown>;
function result(xml: string, operation: string): Record<string, unknown> {
  if (xml.length > 1_048_576 || /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) return invalid();
  const parsed: unknown = new XMLParser({removeNSPrefix:true,ignoreAttributes:true,parseTagValue:false}).parse(xml);
  const body = record(record(record(parsed).Envelope).Body);
  if (body.Fault !== undefined) throw new ArcaQueryError("wsfe", "soap-fault");
  const data = record(record(body[`${operation}Response`])[`${operation}Result`]);
  if (data.Errors !== undefined && data.Errors !== "") {
    const errs = record(data.Errors).Err;
    const items = Array.isArray(errs) ? errs : [errs];
    if (items.length < 1 || items.length > 100) return invalid();
    const codes = items.map(item => record(item).Code);
    if (codes.some(code => typeof code !== "string" || !/^\d{1,9}$/.test(code))) return invalid();
    throw new ArcaQueryError("wsfe", "provider-errors", { providerCodes: codes.map(Number) });
  }
  return data;
}
export interface DummyStatus { appServer: "OK"; dbServer: "OK"; authServer: "OK" }
export function parseDummyResponse(xml: string): DummyStatus {
  const data = result(xml, "FEDummy");
  if ([data.AppServer,data.DbServer,data.AuthServer].some(value => value !== "OK")) return invalid();
  return { appServer:"OK", dbServer:"OK", authServer:"OK" };
}
export interface TipoCbte { id: number; description: string; validFrom: string; validTo: string | null }
export function parseTiposCbteResponse(xml: string): TipoCbte[] {
  const data = result(xml, "FEParamGetTiposCbte");
  const entries = record(data.ResultGet).CbteTipo;
  const items = Array.isArray(entries) ? entries : [entries];
  if (items.length < 1 || items.length > 1000) return invalid();
  const seen = new Set<number>();
  return items.map(item => {
    const row = record(item);
    if (typeof row.Id !== "string" || !/^\d{1,3}$/.test(row.Id) || Number(row.Id) < 1 || seen.has(Number(row.Id))) return invalid();
    seen.add(Number(row.Id));
    if (typeof row.Desc !== "string" || row.Desc.length > 500 || typeof row.FchDesde !== "string" || !/^\d{8}$/.test(row.FchDesde) || (row.FchHasta !== "NULL" && (typeof row.FchHasta !== "string" || !/^\d{8}$/.test(row.FchHasta)))) return invalid();
    return { id:Number(row.Id), description:row.Desc, validFrom:row.FchDesde, validTo:row.FchHasta === "NULL" ? null : row.FchHasta as string };
  });
}
