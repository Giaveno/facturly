import { XMLParser, XMLValidator } from "fast-xml-parser";
import { ArcaBusinessError } from "./errors";
import { ArcaQueryError } from "./query-diagnostics";
import type { ArcaObservation, FecaesolicitarResult, FecompConsultarResult } from "./wsfe";
type RecordValue = Record<string, unknown>;
/** A malformed issuance is terminal/uncertain, NEVER an automatic retry. */
function boundary(xml: string, issuance: boolean) {
    const fail = (category: "malformed-response" | "soap-fault" = "malformed-response"): never => {
        if (issuance)
            throw new ArcaBusinessError(`ARCA issuance outcome uncertain (${category}); read-only verification required`, { stage: "issuance", category });
        throw new ArcaQueryError("wsfe", category);
    };
    const record = (v: unknown): RecordValue => !v || typeof v !== "object" || Array.isArray(v) ? fail() : v as RecordValue;
    let parsed: unknown;
    try {
        if (Buffer.byteLength(xml, "utf8") > 1048576 || /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
            fail();
        parsed = new XMLParser({ removeNSPrefix: true, ignoreAttributes: true, parseTagValue: false, parseAttributeValue: false }).parse(xml);
    }
    catch {
        return fail();
    }
    const root = record(parsed);
    if (Object.keys(root).some(key => key !== "Envelope" && key !== "?xml"))
        fail();
    const body = record(record(root.Envelope).Body);
    if (body.Fault !== undefined)
        fail("soap-fault");
    const operation = issuance ? "FECAESolicitar" : "FECompConsultar";
    if (Object.keys(body).length !== 1)
        fail();
    const response = record(body[`${operation}Response`]);
    if (Object.keys(response).length !== 1)
        fail();
    const result = record(response[`${operation}Result`]);
    const numeric = (v: unknown, max: number, zero = false): number => {
        if (typeof v !== "string" || !/^\d{1,15}$/.test(v))
            return fail();
        const n = Number(v);
        if (!Number.isSafeInteger(n) || n > max || n < (zero ? 0 : 1))
            return fail();
        return n;
    };
    const optionalNumber = (v: unknown, max: number, zero = false) => v === undefined ? null : numeric(v, max, zero);
    const date = (v: unknown): string => {
        if (typeof v !== "string" || !/^\d{8}$/.test(v))
            return fail();
        const iso = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
        const d = new Date(`${iso}T00:00:00Z`);
        if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== iso)
            return fail();
        return v;
    };
    const observations = (v: unknown, tag: string): ArcaObservation[] => {
        if (v === undefined || v === "")
            return [];
        const raw = record(v)[tag];
        const items = Array.isArray(raw) ? raw : [raw];
        if (!items.length || items.length > 100)
            return fail();
        return items.map(item => { const code = record(item).Code; if (typeof code !== "string" || !/^\d{1,9}$/.test(code))
            return fail(); return { code, msg: "ARCA provider observation" }; });
    };
    const errors = observations(result.Errors, "Err");
    if (!issuance && errors.length) {
        // Mixed error/data is ambiguous, never usable fiscal evidence.
        if (result.ResultGet !== undefined && result.ResultGet !== "")
            fail();
        throw new ArcaQueryError("wsfe", "provider-errors", { providerCodes: errors.map(e => Number(e.code)) });
    }
    return { fail, record, result, numeric, optionalNumber, date, observations, errors };
}
export function parseIssuance(xml: string): FecaesolicitarResult {
    const b = boundary(xml, true);
    // A real Errors-only response retains its codes, rather than inventing a rejection.
    if (b.errors.length && b.result.FeCabResp === undefined && b.result.FeDetResp === undefined) {
        return { providerErrorsOnly: true, resultado: "provider-error", cae: null, caeFchVto: null, cbteNro: null, errors: b.errors, observaciones: [] };
    }
    const header = b.record(b.result.FeCabResp);
    const detail = b.record(b.record(b.result.FeDetResp).FECAEDetResponse);
    if (!["A", "R", "P"].includes(header.Resultado as string) || header.Resultado !== detail.Resultado)
        b.fail();
    const cbteNro = b.numeric(detail.CbteDesde, 99999999);
    if (b.numeric(detail.CbteHasta, 99999999) !== cbteNro)
        b.fail();
    if (header.CantReg !== undefined && header.CantReg !== "1")
        b.fail();
    const accepted = header.Resultado === "A";
    if (typeof header.Cuit !== "string" || !/^\d{11}$/.test(header.Cuit))
        b.fail();
    const ptoVta = b.numeric(header.PtoVta, 99999);
    const cbteTipo = b.numeric(header.CbteTipo, 999);
    const fechaEmision = b.date(detail.CbteFch);
    if (accepted && b.errors.length)
        b.fail();
    const cae = accepted ? validCae(detail.CAE, b.fail) : null;
    const caeFchVto = accepted ? b.date(detail.CAEFchVto) : null;
    if (!accepted && (detail.CAE || detail.CAEFchVto))
        b.fail();
    return { resultado: header.Resultado as string, cuit: header.Cuit as string, ptoVta, cbteTipo, fechaEmision, cae, caeFchVto, cbteNro, errors: b.errors, observaciones: b.observations(detail.Observaciones, "Obs") };
}
function validCae(v: unknown, fail: () => never): string {
    if (typeof v !== "string" || !/^\d{14}$/.test(v) || /^0+$/.test(v))
        return fail();
    return v;
}
export function parseConsultation(xml: string): FecompConsultarResult {
    const b = boundary(xml, false);
    const d = b.record(b.result.ResultGet);
    if (typeof d.Resultado !== "string" || !["A", "R", "P"].includes(d.Resultado))
        b.fail();
    const emissionType = d.EmisionTipo === "CAE" || d.EmisionTipo === "CAEA" ? d.EmisionTipo : "unknown";
    if (d.EmisionTipo !== undefined && typeof d.EmisionTipo !== "string")
        b.fail();
    const accepted = d.Resultado === "A" && emissionType === "CAE";
    const cae = accepted ? validCae(d.CodAutorizacion, b.fail) : null;
    const caeFchVto = accepted ? b.date(d.FchVto) : null;
    const from = b.optionalNumber(d.CbteDesde, 99999999);
    const to = b.optionalNumber(d.CbteHasta, 99999999);
    if (from !== null && to !== null && from !== to)
        b.fail();
    const cbteNro = from !== null && to !== null ? from : null;
    const money = (v: unknown) => {
        if (v === undefined)
            return null;
        if (typeof v !== "string" || !/^\d{1,12}(\.\d{1,2})?$/.test(v))
            return b.fail();
        const [whole, decimal = ""] = v.split(".");
        const n = Number(whole) * 100 + Number(decimal.padEnd(2, "0"));
        if (!Number.isSafeInteger(n))
            return b.fail();
        return n;
    };
    let moneda: string | null = null;
    if (d.MonId !== undefined) {
        if (typeof d.MonId !== "string" || !/^[A-Z]{3}$/.test(d.MonId))
            b.fail();
        moneda = d.MonId as string;
    }
    let cotizacion: number | null = null;
    if (d.MonCotiz !== undefined) {
        if (typeof d.MonCotiz !== "string" || !/^\d{1,10}(\.\d{1,6})?$/.test(d.MonCotiz) || Number(d.MonCotiz) <= 0)
            b.fail();
        cotizacion = Number(d.MonCotiz);
    }
    b.observations(d.Observaciones, "Obs");
    return { resultado: d.Resultado as string, cae, caeFchVto, cbteNro, emissionType,
        condicionIvaReceptorId: b.optionalNumber(d.CondicionIVAReceptorId, 999), concepto: b.optionalNumber(d.Concepto, 3),
        impTotConcCentavos: money(d.ImpTotConc), impOpExCentavos: money(d.ImpOpEx), impTribCentavos: money(d.ImpTrib),
        ptoVta: b.optionalNumber(d.PtoVta, 99999), cbteTipo: b.optionalNumber(d.CbteTipo, 999),
        docTipo: b.optionalNumber(d.DocTipo, 999), docNro: b.optionalNumber(d.DocNro, 99999999999, true),
        fechaEmision: d.CbteFch === undefined ? null : b.date(d.CbteFch),
        impTotalCentavos: money(d.ImpTotal), impNetoCentavos: money(d.ImpNeto), impIvaCentavos: money(d.ImpIVA), moneda, cotizacion };
}
