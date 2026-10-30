import { afterAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/test-support/test-db";
import { clients, batches, photos, ocrRows, comprobantes } from "@/lib/db/schema";
import { materializeInvoice, markInvoiceReviewed, approveInvoice } from "@/lib/review/workflow";
import { TaCache, type TaCacheEntry } from "@/adapters/arca/ta-cache";
import { ArcaGatewayProd } from "@/adapters/arca/arca-gateway.prod";
import { WsfeClient } from "@/adapters/arca/wsfe";
import { PadronA5Client } from "@/adapters/arca/padron";
import { createFetchTransport } from "@/adapters/arca/http";
import { fiscalDate } from "@/domain/fiscal-date";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { KnownArcaCause } from "@/app/(app)/invoices/comprobantes-list";
import { interpretEmissionResponse } from "@/app/(app)/emission/emission-form";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/emission/gateway", () => ({ buildArcaGateway: vi.fn() }));
import { getDb } from "@/lib/db/client";
import { buildArcaGateway } from "@/lib/emission/gateway";
import { emitBatchJob } from "./emit";

const soap = (body: string) => `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${body}</soap:Body></soap:Envelope>`;
describe("offline complete review approval with expired WSAA ticket", () => {
  afterAll(() => vi.unstubAllEnvs());
  it("renews once through cache and completes the real job/service/SOAP path within its budget", async () => {
    const handle = await createTestDb();
    const now = new Date();
    const logs: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation(line => logs.push(String(line)));
    const forbiddenNetwork = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Real network forbidden"); });
    vi.stubEnv("EMISSIONS_ENABLED", "true"); vi.stubEnv("ARCA_ENV", "homologacion");
    let logins = 0, heads = 0, issues = 0, modeledRemoteMs = 0;
    let entry: TaCacheEntry = { token: "FAKE_EXPIRED_TOKEN", sign: "FAKE_EXPIRED_SIGN", expiresAt: now.getTime() - 1, issuedAt: now.getTime() - 43_200_000 };
    const cache = new TaCache({
      clock: () => now,
      store: { get: async () => entry, put: async (_key, value) => { entry = value; } },
      wsaa: { loginCms: async () => { logins++; modeledRemoteMs += 25_000; return { token: "FAKE_FRESH_TOKEN", sign: "FAKE_FRESH_SIGN", expirationTime: new Date(now.getTime() + 43_200_000).toISOString() }; } },
    });
    const fakeFetch: typeof fetch = async (_url, init) => {
      modeledRemoteMs += 25_000;
      const body = String(init?.body);
      expect(body).toContain("FAKE_FRESH_TOKEN");
      if (body.includes("<ar:FECompUltimoAutorizado>")) {
        heads++;
        return new Response(soap("<FECompUltimoAutorizadoResponse><FECompUltimoAutorizadoResult><PtoVta>1</PtoVta><CbteTipo>11</CbteTipo><CbteNro>0</CbteNro></FECompUltimoAutorizadoResult></FECompUltimoAutorizadoResponse>"), { headers: { "content-type": "text/xml" } });
      }
      expect(body).toContain("<ar:FECAESolicitar>");
      issues++;
      const date = fiscalDate(now).replaceAll("-", "");
      return new Response(soap(`<FECAESolicitarResponse><FECAESolicitarResult><FeCabResp><Cuit>20123456786</Cuit><PtoVta>1</PtoVta><CbteTipo>11</CbteTipo><Resultado>A</Resultado><Reproceso>N</Reproceso></FeCabResp><FeDetResp><FECAEDetResponse><CbteDesde>1</CbteDesde><CbteHasta>1</CbteHasta><CbteFch>${date}</CbteFch><Resultado>A</Resultado><CAE>70212345678901</CAE><CAEFchVto>20261110</CAEFchVto></FECAEDetResponse></FeDetResp></FECAESolicitarResult></FECAESolicitarResponse>`), { headers: { "content-type": "text/xml" } });
    };
    const gateway = new ArcaGatewayProd({ taCache: cache, emissionsEnabled: true, environment: "homologacion", wsfe: new WsfeClient({ url: "https://offline.invalid/wsfe", transport: createFetchTransport({ fetchFn: fakeFetch }) }), padron: new PadronA5Client({ url: "https://offline.invalid/padron", transport: { post: async () => { throw new Error("CF must not query registry"); } } }) });
    try {
      const [company] = await handle.db.insert(clients).values({ cuit: "20123456786", razonSocial: "Emisor offline", condicionIva: "exento", ptoVta: 1 }).returning();
      const [batch] = await handle.db.insert(batches).values({ clientId: company!.id }).returning();
      const [photo] = await handle.db.insert(photos).values({ batchId: batch!.id, storageKey: "offline.png" }).returning();
      const [row] = await handle.db.insert(ocrRows).values({ photoId: photo!.id, recipientMode: "consumer_final", fields: { name: "Servicio offline", amount: 100000, date: fiscalDate(now) }, confidence: {}, status: "CORRECTED" }).returning();
      const invoice = await materializeInvoice(handle.db, row!.id);
      await markInvoiceReviewed(handle.db, invoice.id);
      const started = performance.now();
      await approveInvoice(handle.db, gateway, invoice.id, () => now, undefined, "homologacion");
      vi.mocked(getDb).mockReturnValue(handle.db as unknown as ReturnType<typeof getDb>);
      vi.mocked(buildArcaGateway).mockReturnValue(gateway);
      const steps: string[] = [];
      const result = await (emitBatchJob as unknown as { fn: (context: unknown) => Promise<unknown> }).fn({ event: { id: "offline-renewal-job", data: { invoiceIds: [invoice.id] } }, step: { run: async (id: string, run: () => unknown) => { steps.push(id); return run(); } } });
      const elapsedMs = performance.now() - started;
      expect(result).toMatchObject({ emitted: 1, failed: 0 });
      expect(steps).toEqual([`emit-invoice-${invoice.id}`]);
      expect({ logins, heads, issues }).toEqual({ logins: 1, heads: 2, issues: 1 });
      expect(modeledRemoteMs).toBe(100_000);
      expect(modeledRemoteMs).toBeLessThan(600_000);
      expect(elapsedMs).toBeLessThan(600_000);
      expect(forbiddenNetwork).not.toHaveBeenCalled();
      const [stored] = await handle.db.select().from(comprobantes);
      expect(stored).toMatchObject({ estado: "aprobado", cbteNro: 1, importeTotalCentavos: 100000 });
      const events = logs.map(line => JSON.parse(line));
      expect(events.filter(event => event.event === "emission_phase").every(event => event.correlation_id === "offline-renewal-job")).toBe(true);
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ phase: "wsaa", login: "succeeded" }), expect.objectContaining({ phase: "dispatched" }), expect.objectContaining({ phase: "final", estado: "aprobado" })]));
      expect(logs.join("\n")).not.toMatch(/FAKE_(EXPIRED|FRESH)_(TOKEN|SIGN)/);
      log.mockRestore();
      process.stdout.write(JSON.stringify({ event: "offline_review_approval_verified", elapsedMs: Math.round(elapsedMs), modeledRemoteMs, routeBudgetMs: 600_000, logins, heads, issues, realNetworkCalls: 0 }) + "\n");
    } finally { log.mockRestore(); forbiddenNetwork.mockRestore(); await handle.close(); }
  });
  it("renders persisted phase/cause in Spanish in both screens without raw JSON", () => {
    const errores = JSON.stringify({ phase: "wsaa", cause: "Certificado de prueba inválido" });
    const html = renderToStaticMarkup(createElement(KnownArcaCause, { estado: "rechazado", errores }));
    expect(html).toContain("Autenticación WSAA"); expect(html).toContain("Certificado de prueba inválido"); expect(html).not.toContain('{&quot;phase');
    expect(interpretEmissionResponse({ estado: "rechazado", errores }).text).toBe("Fase: Autenticación WSAA. Causa: Certificado de prueba inválido");
  });
});
