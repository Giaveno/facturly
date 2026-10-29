import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { ArcaGatewayFake } from "@/adapters/arca/arca-gateway.fake";
import { clients, comprobantes, emissionSeriesClaims } from "@/lib/db/schema";
import { createTestDb } from "@/test-support/test-db";
import { emitComprobante } from "./comprobante-emission-service";

const now = () => new Date("2026-10-29T12:00:00Z");
const item = { descripcion: "Servicio", netoCentavos: 100, ivaCentavos: 21, exentoCentavos: 0, tributosCentavos: 0, totalCentavos: 121, alicuota: 21 as const };

describe("credit note emission", () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => { handle = await createTestDb(); });
  afterAll(async () => { await handle.close(); });
  beforeEach(async () => { await handle.db.delete(comprobantes); await handle.db.delete(emissionSeriesClaims); await handle.db.delete(clients); });
  async function company(cuit = "20123456786") {
    const [row] = await handle.db.insert(clients).values({ cuit, razonSocial: "Empresa", ptoVta: 1, condicionIva: "ri" }).returning();
    return row!.id;
  }
  async function original(empresaId: string, overrides: Partial<typeof comprobantes.$inferInsert> = {}) {
    const [row] = await handle.db.insert(comprobantes).values({ empresaId, ambiente: "homologacion", emisorCuit: "20123456786", emisorCondicionIva: "ri", cbteTipo: 1, ptoVta: 1, cbteNro: 1, concepto: 1, docTipo: 99, docNro: "0", condicionIvaReceptor: 5, fecha: "2026-10-29", importeNetoCentavos: 100, importeIvaCentavos: 21, importeExentoCentavos: 0, importeTributosCentavos: 0, importeTotalCentavos: 121, items: [item], estado: "aprobado", cae: "70000000000001", caeVto: "2026-11-08", resultado: "A", idempotencyKey: `original-${empresaId}`, ...overrides }).returning();
    return row!;
  }
  function note(empresaId: string, originalId: string, key = `note-${originalId}`) {
    return { empresaId, idempotencyKey: key, comprobanteAsociadoId: originalId, emisorCuit: "20123456786", emisorCondicionIva: "ri" as const, cbteTipo: 3, ptoVta: 1, concepto: 1, docTipo: 99, docNro: "0", condicionIvaReceptor: 5, fecha: "2026-10-29", importeNetoCentavos: 100, importeIvaCentavos: 21, importeExentoCentavos: 0, importeTributosCentavos: 0, importeTotalCentavos: 121, items: [item] };
  }
  it("issues a mapped credit note and sends the CbtesAsoc reference", async () => {
    const empresaId = await company(); const source = await original(empresaId); const gateway = new ArcaGatewayFake(undefined, now); const issue = vi.spyOn(gateway, "issueInvoice");
    const result = await emitComprobante({ db: handle.db, gateway, environment: "homologacion", env: { EMISSIONS_ENABLED: "true", ARCA_ENV: "homologacion" }, now }, note(empresaId, source.id));
    expect(result.estado).toBe("aprobado"); expect(issue.mock.calls[0]![0].cbteTipo).toBe(3); expect(issue.mock.calls[0]![0].cbtesAsoc).toEqual([{ tipo: 1, ptoVta: 1, nro: 1 }]);
  });
  it("reconciles a timed-out credit note on same-key retry instead of returning early", async () => {
    const empresaId = await company(); const source = await original(empresaId); const base = new ArcaGatewayFake(undefined, now);
    const timedOut = {
      getIvaCondition: base.getIvaCondition.bind(base), ultimoAutorizado: base.ultimoAutorizado.bind(base), consultInvoice: base.consultInvoice.bind(base),
      issueInvoice: async (request: Parameters<ArcaGatewayFake["issueInvoice"]>[0]) => { await base.issueInvoice(request); throw new Error("timeout after authorization"); },
    };
    const request = note(empresaId, source.id, "timeout-credit-note");
    const first = await emitComprobante({ db: handle.db, gateway: timedOut, environment: "homologacion", env: { EMISSIONS_ENABLED: "true", ARCA_ENV: "homologacion" }, now }, request);
    expect(first.estado).toBe("incierto");
    const issue = vi.spyOn(base, "issueInvoice");
    const second = await emitComprobante({ db: handle.db, gateway: base, environment: "homologacion", env: { EMISSIONS_ENABLED: "true", ARCA_ENV: "homologacion" }, now, uncertainGraceMs: 0 }, request);
    expect(second).toMatchObject({ estado: "aprobado", cbteNro: first.cbteNro, emitted: false });
    expect(issue).not.toHaveBeenCalled();
  });
  it("rejects cumulative excess before any gateway call", async () => {
    const empresaId = await company(); const source = await original(empresaId); await handle.db.insert(comprobantes).values({ ...note(empresaId, source.id, "prior"), ambiente: "homologacion", cbteNro: 2, estado: "aprobado", cae: "70000000000002", caeVto: "2026-11-08", resultado: "A" });
    const gateway = new ArcaGatewayFake(undefined, now); const calls = vi.spyOn(gateway, "ultimoAutorizado");
    await expect(emitComprobante({ db: handle.db, gateway, environment: "homologacion", env: { EMISSIONS_ENABLED: "true", ARCA_ENV: "homologacion" }, now }, note(empresaId, source.id))).rejects.toThrow(/supera/); expect(calls).not.toHaveBeenCalled();
  });
  it.each(["borrador", "incierto"] as const)("rejects a non-approved original (%s) before ARCA", async (status) => {
    const empresaId = await company(); const source = await original(empresaId); await handle.db.update(comprobantes).set({ estado: status, cae: null, caeVto: null }).where(eq(comprobantes.id, source.id)); const gateway = new ArcaGatewayFake(undefined, now); const calls = vi.spyOn(gateway, "ultimoAutorizado");
    await expect(emitComprobante({ db: handle.db, gateway, environment: "homologacion", env: { EMISSIONS_ENABLED: "true", ARCA_ENV: "homologacion" }, now }, note(empresaId, source.id))).rejects.toThrow(/aprobado/); expect(calls).not.toHaveBeenCalled();
  });
  it("rejects an original belonging to another company before ARCA", async () => {
    const sourceCompany = await company(); const targetCompany = await company("20123456787"); const source = await original(sourceCompany); const gateway = new ArcaGatewayFake(undefined, now); const calls = vi.spyOn(gateway, "ultimoAutorizado");
    await expect(emitComprobante({ db: handle.db, gateway, environment: "homologacion", env: { EMISSIONS_ENABLED: "true", ARCA_ENV: "homologacion" }, now }, note(targetCompany, source.id))).rejects.toThrow(/otra empresa/); expect(calls).not.toHaveBeenCalled();
  });
  it("rejects a wrong credit-note type before ARCA", async () => {
    const empresaId = await company(); const source = await original(empresaId); const gateway = new ArcaGatewayFake(undefined, now); const calls = vi.spyOn(gateway, "ultimoAutorizado");
    await expect(emitComprobante({ db: handle.db, gateway, environment: "homologacion", env: { EMISSIONS_ENABLED: "true", ARCA_ENV: "homologacion" }, now }, { ...note(empresaId, source.id), cbteTipo: 8 })).rejects.toThrow(/tipo de nota/); expect(calls).not.toHaveBeenCalled();
  });
  it.each([
    ["environment", { ambiente: "produccion" as const }],
    ["point of sale", { ptoVta: 2 }],
  ])("rejects an original from another %s before ARCA", async (_label, overrides) => {
    const empresaId = await company(); const source = await original(empresaId, overrides); const gateway = new ArcaGatewayFake(undefined, now); const calls = vi.spyOn(gateway, "ultimoAutorizado");
    await expect(emitComprobante({ db: handle.db, gateway, environment: "homologacion", env: { EMISSIONS_ENABLED: "true", ARCA_ENV: "homologacion" }, now }, note(empresaId, source.id))).rejects.toThrow(/ambiente o punto de venta/); expect(calls).not.toHaveBeenCalled();
  });
});
