import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { generateSelfSignedCert } from "@/test-support/pkcs7";
import { inspectCertificate } from "@/lib/credentials/pem";
import { deriveAesKey, encryptPrivateKey } from "@/lib/db/credentials";
import { WSAA_HOMOLOGACION_URL, WSFE_HOMOLOGACION_URL } from "@/adapters/arca/constants";
import { createInvoiceConsultation, compareFiscalEvidence, type ReservedInvoice } from "./reconciliation";
import { parseFecompConsultarResponse } from "@/adapters/arca/wsfe";
const xml = (d: string) => `<Envelope><Body><FECompConsultarResponse><FECompConsultarResult>${d}</FECompConsultarResult></FECompConsultarResponse></Body></Envelope>`;
const detail = `<ResultGet><Resultado>A</Resultado><EmisionTipo>CAE</EmisionTipo><CodAutorizacion>70212345678901</CodAutorizacion><FchVto>20261107</FchVto><CbteDesde>7</CbteDesde><CbteHasta>7</CbteHasta><CbteFch>20261028</CbteFch><PtoVta>1</PtoVta><CbteTipo>11</CbteTipo><DocTipo>99</DocTipo><DocNro>0</DocNro><ImpTotal>100.00</ImpTotal><ImpNeto>100.00</ImpNeto><ImpIVA>0.00</ImpIVA><MonId>PES</MonId><MonCotiz>1</MonCotiz></ResultGet>`;
let pair: ReturnType<typeof generateSelfSignedCert>;
beforeAll(() => { pair = generateSelfSignedCert("TEST"); });
afterEach(() => vi.useRealTimers());
const row = (): ReservedInvoice => ({ invoiceId: "00000000-0000-4000-8000-000000000001", reservationId: "reservation", status: "EMIT_FAILED", cae: null, cuit: "30710145764", ptoVta: 1, cbteTipo: 11, cbteNro: 7, importeTotalCentavos: 10000, invoiceCbteTipo: 11, net: 10000, iva: 0, total: 10000, moneda: "PES", cotizacion: 1, docTipo: 99, docNro: 0, fechaEmision: "2026-10-28", approvalSnapshot: { environment: "homologacion", issuerCuit: "30710145764", ptoVta: 1, rowId: "row", issuerName: "TEST", issuerCondition: "monotributista", name: "", cuit: "", recipientMode: "consumer_final", taxRate: null, date: "2026-10-28", amount: 10000 } });
function setup() {
    let current: ReservedInvoice | null = row();
    let stored = { certPem: pair.certPem, encryptedKey: encryptPrivateKey(pair.keyPem, deriveAesKey("01".repeat(32))) };
    const fingerprint = inspectCertificate(pair.certPem).fingerprint;
    const repository = { get: vi.fn(async () => stored) };
    const getReservation = vi.fn(async () => current);
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(xml(detail)));
    const store = { get: vi.fn(async (key: string) => key === `${WSAA_HOMOLOGACION_URL}:${fingerprint}:wsfe` ? { token: "SECRET_TOKEN", sign: "SECRET_SIGN", expiresAt: Date.now() + 3600000, issuedAt: Date.now() } : null), put: vi.fn() };
    const env: Record<string, string | undefined> = { ARCA_ENV: "homologacion", AES_KEY: "01".repeat(32), EMISSIONS_ENABLED: "false" };
    const query = createInvoiceConsultation({ env, repository, getReservation, fetchFn, store });
    return { query, env, repository, getReservation, fetchFn, store, edit: (patch: Partial<ReservedInvoice>) => { current = { ...current!, ...patch }; }, changeKey: () => { stored = { ...stored, encryptedKey: encryptPrivateKey(pair.keyPem, deriveAesKey("01".repeat(32))) }; } };
}
describe("read-only reserved-invoice consultation", () => {
    it("preserves numeric codes on HTTP provider errors without interpreting a failed HTTP response as no-record", async () => {
        const s = setup();
        s.fetchFn.mockResolvedValue(new Response(xml('<Errors><Err><Code>602</Code><Msg>SECRET_TOKEN</Msg></Err></Errors>'), { status: 500 }));
        await expect(s.query(row().invoiceId)).rejects.toMatchObject({ code: "upstream", diagnostic: { stage: "wsfe", category: "provider-errors", httpStatus: 500, providerCodes: [602] } });
    });
    it("requires explicit environment before any dependencies", async () => { const s = setup(); s.env.ARCA_ENV = "production"; await expect(s.query(row().invoiceId)).rejects.toMatchObject({ code: "environment" }); expect(s.getReservation).not.toHaveBeenCalled(); expect(s.repository.get).not.toHaveBeenCalled(); expect(s.fetchFn).not.toHaveBeenCalled(); });
    it.each([null, {}, { environment: "production" }])("refuses unknown/legacy approval environment before secrets", async (approvalSnapshot) => { const s = setup(); s.edit({ approvalSnapshot }); await expect(s.query(row().invoiceId)).rejects.toMatchObject({ code: "environment" }); expect(s.repository.get).not.toHaveBeenCalled(); expect(s.fetchFn).not.toHaveBeenCalled(); });
    it("uses only exact reservation and returns a public CAE without fiscal writes", async () => { const s = setup(); const report = await s.query(row().invoiceId); expect(report).toMatchObject({ status: "matched", cae: "70212345678901", environment: "homologacion", tuple: { cuit: "30710145764", ptoVta: 1, cbteTipo: 11, cbteNro: 7 } }); expect(s.fetchFn).toHaveBeenCalledTimes(1); const [url, init] = s.fetchFn.mock.calls[0]!; expect(url).toBe(WSFE_HOMOLOGACION_URL); expect(init?.body).toContain("<ar:CbteNro>7</ar:CbteNro>"); expect(init?.body).not.toMatch(/FECAESolicitar|FECompUltimoAutorizado/); expect(JSON.stringify(report)).not.toMatch(/SECRET|PRIVATE|BEGIN/); expect(s.store.put).not.toHaveBeenCalled(); await s.query(row().invoiceId); expect(s.fetchFn).toHaveBeenCalledTimes(1); });
    it.each(["reservation", "certificate"])("discards stale %s after network", async (kind) => { const s = setup(); s.fetchFn.mockImplementation(async () => { if (kind === "reservation")
        s.edit({ cbteNro: 8 });
    else
        s.changeKey(); return new Response(xml(detail)); }); await expect(s.query(row().invoiceId)).rejects.toMatchObject({ code: "changed" }); });
    it("602 means no-record returned, not never issued; malformed/timeouts are not no-record", async () => { const s = setup(); s.fetchFn.mockResolvedValue(new Response(xml('<Errors><Err><Code>602</Code><Msg>SECRET</Msg></Err></Errors>'))); expect(await s.query(row().invoiceId)).toMatchObject({ status: "no-record", cae: null }); const t = setup(); t.fetchFn.mockResolvedValue(new Response("<Envelope/>")); await expect(t.query(row().invoiceId)).rejects.toMatchObject({ diagnostic: { category: "malformed-response" } }); });
    it("rejects returned mismatches and missing match fields", () => { const r = parseFecompConsultarResponse(xml(detail)); expect(compareFiscalEvidence(row(), r)).toBe("matched"); for (const patch of [{ ptoVta: 2 }, { impTotalCentavos: 20000 }, { docNro: 123 }, { moneda: "DOL" }, { emissionType: "CAEA" as const }, { impTotalCentavos: null }, { docTipo: null }, { fechaEmision: null }])
        expect(compareFiscalEvidence(row(), { ...r, ...patch })).toBe("unverified"); });
    it("shares in-flight requests and cools down failures", async () => { const s = setup(); s.fetchFn.mockRejectedValue(new Error("SECRET_TOKEN PRIVATE KEY")); const results = await Promise.all([s.query(row().invoiceId).catch(e => e), s.query(row().invoiceId).catch(e => e)]); expect(results[0]).toMatchObject({ code: "upstream", diagnostic: { stage: "wsfe", category: "network" } }); expect(JSON.stringify(results)).not.toContain("SECRET"); await s.query(row().invoiceId).catch(() => { }); expect(s.fetchFn).toHaveBeenCalledTimes(1); });
    it("bounds ignored network abort without misreporting no-record", async () => { vi.useFakeTimers(); const s = setup(); s.fetchFn.mockImplementation(() => new Promise(() => { })); const pending = s.query(row().invoiceId).catch(e => e); await vi.advanceTimersByTimeAsync(4500); expect(await pending).toMatchObject({ code: "upstream", diagnostic: { stage: "wsfe", category: "timeout" } }); });
    it.each(["header", "stream"])("bounds %s response size", async (kind) => { const s = setup(); s.fetchFn.mockImplementation(async () => new Response("x".repeat(kind === "stream" ? 1048577 : 1), { headers: kind === "header" ? { "content-length": "1048577" } : {} })); await expect(s.query(row().invoiceId)).rejects.toMatchObject({ code: "upstream", diagnostic: { category: "response-too-large" } }); });
    it.each(["production", undefined])("refuses current environment %s, even with a homologation snapshot", async (environment) => { const s = setup(); s.env.ARCA_ENV = environment; await expect(s.query(row().invoiceId)).rejects.toMatchObject({ code: "environment" }); expect(s.repository.get).not.toHaveBeenCalled(); });
    it.each(["no-mode", "rejected", "missing-total", "CAEA"])("does not authorize %s query evidence", async (kind) => { const s = setup(); let d = detail; if (kind === "no-mode")
        d = d.replace("<EmisionTipo>CAE</EmisionTipo>", ""); if (kind === "rejected")
        d = d.replace("<Resultado>A", "<Resultado>R"); if (kind === "missing-total")
        d = d.replace("<ImpTotal>100.00</ImpTotal>", ""); if (kind === "CAEA")
        d = d.replace("<EmisionTipo>CAE", "<EmisionTipo>CAEA"); s.fetchFn.mockResolvedValue(new Response(xml(d))); expect((await s.query(row().invoiceId)).status).toBe("unverified"); });
});
