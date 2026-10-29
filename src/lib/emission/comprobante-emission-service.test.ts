import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { ArcaBusinessError } from "@/adapters/arca/errors";
import { ArcaGatewayFake } from "@/adapters/arca/arca-gateway.fake";
import type { ArcaGateway } from "@/ports/arca-gateway";
import type { Db } from "@/lib/db/types";
import { createTestDb } from "@/test-support/test-db";
import { clients, comprobantes, emissionSeriesClaims } from "@/lib/db/schema";
import {
  emitComprobante,
  recoverSeriesClaim,
  EMISSION_UNCERTAIN_REASON,
  IDEMPOTENCY_CONFLICT_REASON,
  RECONCILIATION_NOT_FOUND_REASON,
  RECONCILIATION_UNCERTAIN_REASON,
  uncertainGraceMs,
  SERIES_BLOCKED_MESSAGE,
} from "./comprobante-emission-service";
import { acquireSeriesClaim, finishSeriesClaim, seriesKey } from "./series-claim";

describe("comprobante emission service", () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  const now = () => new Date("2026-10-29T12:00:00Z");

  beforeAll(async () => { handle = await createTestDb(); });
  it("checks the kill switch before any database access or gateway call, including default env", async () => {
    const db = new Proxy({} as Db, { get() { throw new Error("database touched"); } });
    const gateway = new Proxy({} as ArcaGateway, { get() { throw new Error("gateway touched"); } });
    vi.stubEnv("EMISSIONS_ENABLED", "false");
    try {
      for (const env of [undefined, { EMISSIONS_ENABLED: "false", ARCA_ENV: "homologacion" }]) {
        await expect(emitComprobante({ db, gateway, env }, {} as never)).rejects.toMatchObject({ code: "EMISSIONS_DISABLED" });
      }
    } finally { vi.unstubAllEnvs(); }
  });
  afterAll(async () => { await handle.close(); });
  beforeEach(async () => {
    await handle.db.delete(comprobantes);
    await handle.db.delete(emissionSeriesClaims);
    await handle.db.delete(clients);
  });

  it("uses three WSFE call budgets by default and accepts a safe grace override", () => {
    expect(uncertainGraceMs("homologacion", {})).toBe(75_000);
    expect(uncertainGraceMs("production", {})).toBe(600_000);
    expect(uncertainGraceMs("homologacion", { ARCA_UNCERTAIN_GRACE_MS: "1234" })).toBe(1234);
  });

  it("rejects a recovery key that does not match its series input before database access", async () => {
    const forbiddenDb = new Proxy({} as Db, { get() { throw new Error("database access"); } });
    await expect(recoverSeriesClaim({ db: forbiddenDb, gateway: {} as ArcaGateway }, {
      key: seriesKey("homologacion", "20123456786", 1, 11),
      environment: "homologacion",
      emisorCuit: "20123456786",
      ptoVta: 1,
      cbteTipo: 1,
    })).rejects.toThrow("no coincide");
  });

  it("does not clear a newer uncertain claim generation during reconciliation", async () => {
    const empresa = await company();
    const base = new ArcaGatewayFake(undefined, now);
    const timedOut = {
      getIvaCondition: base.getIvaCondition.bind(base),
      ultimoAutorizado: base.ultimoAutorizado.bind(base),
      consultInvoice: base.consultInvoice.bind(base),
      issueInvoice: async () => { throw new Error("network timeout"); },
    };
    await emitComprobante({ db: handle.db, gateway: timedOut, environment: "homologacion", env: { EMISSIONS_ENABLED: "true", ARCA_ENV: "homologacion" }, now, uncertainGraceMs: 0 }, input(empresa, "generation-a"));
    const key = seriesKey("homologacion", "20123456786", 1, 1);
    const recovering = {
      getIvaCondition: base.getIvaCondition.bind(base),
      ultimoAutorizado: base.ultimoAutorizado.bind(base),
      consultInvoice: async () => {
        await handle.db.update(emissionSeriesClaims).set({ leaseExpiresAtMs: 2_000, uncertainSinceMs: 2_000 }).where(eq(emissionSeriesClaims.seriesKey, key));
        return null;
      },
      issueInvoice: async () => { throw new Error("must not issue"); },
    };
    await expect(emitComprobante({ db: handle.db, gateway: recovering, environment: "homologacion", env: { EMISSIONS_ENABLED: "true", ARCA_ENV: "homologacion" }, now, uncertainGraceMs: 0 }, input(empresa, "generation-b"))).rejects.toThrow(SERIES_BLOCKED_MESSAGE);
  });

  async function company(cuit = "20123456786") {
    const [row] = await handle.db.insert(clients).values({ cuit, razonSocial: "Empresa", ptoVta: 1, condicionIva: "ri" }).returning();
    return row!.id;
  }

  function input(empresaId: string, idempotencyKey = crypto.randomUUID(), cuit = "20123456786") {
    return {
      empresaId, idempotencyKey, emisorCuit: cuit, emisorCondicionIva: "ri" as const,
      cbteTipo: 1, ptoVta: 1, concepto: 1, docTipo: 99, docNro: "0", condicionIvaReceptor: 5,
      fecha: "2026-10-29", importeNetoCentavos: 100, importeIvaCentavos: 21,
      importeExentoCentavos: 0, importeTributosCentavos: 0, importeTotalCentavos: 121,
      items: [{ descripcion: "Servicio", netoCentavos: 100, ivaCentavos: 21, exentoCentavos: 0, tributosCentavos: 0, totalCentavos: 121, alicuota: 21 as const }],
    };
  }

  async function insertDraft(empresaId: string, idempotencyKey: string, overrides: Partial<typeof comprobantes.$inferInsert> = {}) {
    const value = input(empresaId, idempotencyKey);
    const [row] = await handle.db.insert(comprobantes).values({
      empresaId,
      ambiente: "homologacion",
      emisorCuit: value.emisorCuit,
      emisorCondicionIva: value.emisorCondicionIva,
      cbteTipo: value.cbteTipo,
      ptoVta: value.ptoVta,
      cbteNro: null,
      concepto: value.concepto,
      docTipo: value.docTipo,
      docNro: value.docNro,
      condicionIvaReceptor: value.condicionIvaReceptor,
      fecha: value.fecha,
      importeNetoCentavos: value.importeNetoCentavos,
      importeIvaCentavos: value.importeIvaCentavos,
      importeExentoCentavos: value.importeExentoCentavos,
      importeTributosCentavos: value.importeTributosCentavos,
      importeTotalCentavos: value.importeTotalCentavos,
      items: value.items,
      estado: "borrador",
      idempotencyKey,
      ...overrides,
    }).returning();
    return row!;
  }

  it("reserves under the series lock and is idempotent per company", async () => {
    const empresa = await company();
    const gateway = new ArcaGatewayFake(undefined, now);
    const request = input(empresa, "same-key");
    const first = await emitComprobante({ db: handle.db, gateway, environment: "homologacion", env: { EMISSIONS_ENABLED: "true", ARCA_ENV: "homologacion" }, now }, request);
    const second = await emitComprobante({ db: handle.db, gateway, environment: "homologacion", env: { EMISSIONS_ENABLED: "true", ARCA_ENV: "homologacion" }, now }, request);
    expect(first).toMatchObject({ estado: "aprobado", cbteNro: 1, emitted: true });
    expect(second).toMatchObject({ estado: "aprobado", cbteNro: 1, emitted: false });
  });

  it("keeps the same key independent across companies", async () => {
    const firstCompany = await company();
    const secondCompany = await company("30710145764");
    const gateway = new ArcaGatewayFake(undefined, now);
    const first = await emitComprobante({ db: handle.db, gateway, environment: "homologacion", env: { EMISSIONS_ENABLED: "true", ARCA_ENV: "homologacion" }, now }, input(firstCompany, "same-key"));
    const second = await emitComprobante({ db: handle.db, gateway, environment: "homologacion", env: { EMISSIONS_ENABLED: "true", ARCA_ENV: "homologacion" }, now }, input(secondCompany, "same-key", "30710145764"));
    expect(first.cbteNro).toBe(1);
    expect(second.cbteNro).toBe(1);
  });

  it("persists a rejection literally and does not retry a provider rejection", async () => {
    const empresa = await company();
    const base = new ArcaGatewayFake(undefined, now);
    const gateway = {
      getIvaCondition: base.getIvaCondition.bind(base),
      ultimoAutorizado: base.ultimoAutorizado.bind(base),
      consultInvoice: base.consultInvoice.bind(base),
      issueInvoice: async () => { throw new ArcaBusinessError("Importe inválido", { code: "10049" }); },
    };
    const result = await emitComprobante({ db: handle.db, gateway, environment: "homologacion", env: { EMISSIONS_ENABLED: "true", ARCA_ENV: "homologacion" }, now }, input(empresa));
    expect(result).toMatchObject({ estado: "rechazado", resultado: "R", cbteNro: 1 });
    expect(result.errores).toContain("10049");
  });

  it("releases the series after a definitive rejection so the next emission can proceed", async () => {
    const empresa = await company();
    const base = new ArcaGatewayFake(undefined, now);
    const rejecting = {
      getIvaCondition: base.getIvaCondition.bind(base),
      ultimoAutorizado: base.ultimoAutorizado.bind(base),
      consultInvoice: base.consultInvoice.bind(base),
      issueInvoice: async () => { throw new ArcaBusinessError("Importe inválido", { code: "10049" }); },
    };
    const rejected = await emitComprobante({ db: handle.db, gateway: rejecting, environment: "homologacion", env: { EMISSIONS_ENABLED: "true", ARCA_ENV: "homologacion" }, now }, input(empresa, "rejected"));
    const next = await emitComprobante({ db: handle.db, gateway: base, environment: "homologacion", env: { EMISSIONS_ENABLED: "true", ARCA_ENV: "homologacion" }, now }, input(empresa, "next-after-rejection"));
    expect(rejected.estado).toBe("rechazado");
    expect(next).toMatchObject({ estado: "aprobado", cbteNro: 1 });
  });

  it("marks a timeout uncertain, then reconciles an absent orphan before the next reservation", async () => {
    const empresa = await company();
    const base = new ArcaGatewayFake(undefined, now);
    const timedOut = {
      getIvaCondition: base.getIvaCondition.bind(base),
      ultimoAutorizado: base.ultimoAutorizado.bind(base),
      consultInvoice: base.consultInvoice.bind(base),
      issueInvoice: async () => { throw new Error("network timeout"); },
    };
    const uncertain = await emitComprobante({ db: handle.db, gateway: timedOut, environment: "homologacion", env: { EMISSIONS_ENABLED: "true", ARCA_ENV: "homologacion" }, now }, input(empresa, "timeout"));
    expect(uncertain).toMatchObject({ estado: "incierto", cbteNro: 1, errores: EMISSION_UNCERTAIN_REASON });
    const next = await emitComprobante({ db: handle.db, gateway: base, environment: "homologacion", env: { EMISSIONS_ENABLED: "true", ARCA_ENV: "homologacion" }, now, uncertainGraceMs: 0 }, input(empresa, "next"));
    expect(next.cbteNro).toBe(1);
    const [orphan] = await handle.db.select().from(comprobantes);
    expect(orphan!.errores).toBe(RECONCILIATION_NOT_FOUND_REASON);
  });

  it("reconciles a timeout when ARCA did authorize the reserved number", async () => {
    const empresa = await company();
    const base = new ArcaGatewayFake(undefined, now);
    const timedOutAfterAuthorization = {
      getIvaCondition: base.getIvaCondition.bind(base),
      ultimoAutorizado: base.ultimoAutorizado.bind(base),
      consultInvoice: base.consultInvoice.bind(base),
      issueInvoice: async (request: Parameters<typeof base.issueInvoice>[0]) => {
        await base.issueInvoice(request);
        throw new Error("response lost after ARCA authorization");
      },
    };
    const uncertain = await emitComprobante({ db: handle.db, gateway: timedOutAfterAuthorization, environment: "homologacion", env: { EMISSIONS_ENABLED: "true", ARCA_ENV: "homologacion" }, now }, input(empresa, "timeout-authorized"));
    expect(uncertain).toMatchObject({ estado: "incierto", cbteNro: 1 });

    const recovered = await emitComprobante({ db: handle.db, gateway: base, environment: "homologacion", env: { EMISSIONS_ENABLED: "true", ARCA_ENV: "homologacion" }, now, uncertainGraceMs: 0 }, input(empresa, "after-reconciliation"));
    expect(recovered.cbteNro).toBe(2);
    const rows = await handle.db.select().from(comprobantes);
    expect(rows.find((row) => row.id === uncertain.id)).toMatchObject({ estado: "aprobado", cae: expect.any(String) });
  });

  it("serializes concurrent emissions for one fiscal series", async () => {
    const empresa = await company();
    const base = new ArcaGatewayFake(undefined, now);
    let calls = 0;
    const gateway = {
      getIvaCondition: base.getIvaCondition.bind(base),
      ultimoAutorizado: base.ultimoAutorizado.bind(base),
      consultInvoice: base.consultInvoice.bind(base),
      issueInvoice: async (request: Parameters<typeof base.issueInvoice>[0]) => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return base.issueInvoice(request);
      },
    };
    const [first, second] = await Promise.all([
      emitComprobante({ db: handle.db, gateway, environment: "homologacion", env: { EMISSIONS_ENABLED: "true", ARCA_ENV: "homologacion" }, now }, input(empresa, "concurrent-a")),
      emitComprobante({ db: handle.db, gateway, environment: "homologacion", env: { EMISSIONS_ENABLED: "true", ARCA_ENV: "homologacion" }, now }, input(empresa, "concurrent-b")),
    ]);
    expect([first.cbteNro, second.cbteNro].sort()).toEqual([1, 2]);
    expect(first.estado).toBe("aprobado");
    expect(second.estado).toBe("aprobado");
    expect(calls).toBe(2);
  });

  it("serializes orphan reconciliation with a concurrent emission claim", async () => {
    const empresa = await company();
    await insertDraft(empresa, "reconcile-race", { estado: "incierto", cbteNro: 1 });
    const key = seriesKey("homologacion", "20123456786", 1, 1);
    await acquireSeriesClaim(handle.db, key, "expired-owner", Date.now() - 1);
    await finishSeriesClaim(handle.db, key, "expired-owner", true, Date.now() - 1);
    const base = new ArcaGatewayFake(undefined, () => new Date());
    let consultStarted!: () => void;
    const started = new Promise<void>((resolve) => { consultStarted = resolve; });
    let releaseConsult!: () => void;
    const release = new Promise<void>((resolve) => { releaseConsult = resolve; });
    let consultCalls = 0;
    const gateway = {
      getIvaCondition: base.getIvaCondition.bind(base),
      ultimoAutorizado: base.ultimoAutorizado.bind(base),
      consultInvoice: async () => {
        consultCalls += 1;
        consultStarted();
        await release;
        return null;
      },
      issueInvoice: base.issueInvoice.bind(base),
    };
    const recovery = recoverSeriesClaim({ db: handle.db, gateway, environment: "homologacion", env: { EMISSIONS_ENABLED: "true", ARCA_ENV: "homologacion" }, now: () => new Date(), uncertainGraceMs: 0 }, {
      key, environment: "homologacion", emisorCuit: "20123456786", ptoVta: 1, cbteTipo: 1,
    });
    await started;
    const emission = emitComprobante({ db: handle.db, gateway, environment: "homologacion", env: { EMISSIONS_ENABLED: "true", ARCA_ENV: "homologacion" }, now: () => new Date(), uncertainGraceMs: 0 }, input(empresa, "after-reconcile-race"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseConsult();
    await recovery;
    await expect(emission).resolves.toMatchObject({ estado: "aprobado", cbteNro: 1 });
    expect(consultCalls).toBe(1);
    const [orphan] = await handle.db.select().from(comprobantes).where(eq(comprobantes.idempotencyKey, "reconcile-race"));
    expect(orphan).toMatchObject({ estado: "rechazado", resultado: "R" });
  });

  it("keeps the reservation when a failure happens before ARCA is called", async () => {
    const empresa = await company();
    const base = new ArcaGatewayFake(undefined, now);
    let issueCalls = 0;
    const gateway = {
      getIvaCondition: base.getIvaCondition.bind(base),
      ultimoAutorizado: base.ultimoAutorizado.bind(base),
      consultInvoice: base.consultInvoice.bind(base),
      issueInvoice: async (...args: Parameters<typeof base.issueInvoice>) => {
        issueCalls += 1;
        return base.issueInvoice(...args);
      },
    };
    const result = await emitComprobante({
      db: handle.db,
      gateway,
      environment: "homologacion", env: { EMISSIONS_ENABLED: "true", ARCA_ENV: "homologacion" },
      now,
      beforeArca: async () => { throw new Error("local dispatch preparation failed"); },
    }, input(empresa, "pre-arca-failure"));
    expect(result).toMatchObject({ estado: "incierto", cbteNro: 1 });
    expect(issueCalls).toBe(0);
    const [persisted] = await handle.db.select().from(comprobantes);
    expect(persisted).toMatchObject({ estado: "incierto", cbteNro: 1 });
  });

  it("revalidates the durable claim immediately before dispatch", async () => {
    const empresa = await company();
    const base = new ArcaGatewayFake(undefined, now);
    let arcaCalls = 0;
    const gateway = {
      getIvaCondition: base.getIvaCondition.bind(base),
      ultimoAutorizado: base.ultimoAutorizado.bind(base),
      consultInvoice: base.consultInvoice.bind(base),
      issueInvoice: async (request: Parameters<typeof base.issueInvoice>[0], before?: () => Promise<void>) => {
        await before?.();
        arcaCalls += 1;
        return base.issueInvoice(request);
      },
    };
    const result = await emitComprobante({
      db: handle.db,
      gateway,
      environment: "homologacion", env: { EMISSIONS_ENABLED: "true", ARCA_ENV: "homologacion" },
      now,
      beforeArca: async () => {
        await handle.db.update(emissionSeriesClaims).set({ owner: null });
      },
    }, input(empresa, "claim-lost"));
    expect(result.estado).toBe("incierto");
    expect(arcaCalls).toBe(0);
    expect(result.cbteNro).toBe(1);
  });

  it("consults and approves the reservation when ARCA advanced before dispatch", async () => {
    const empresa = await company();
    let latestCalls = 0;
    let consultCalls = 0;
    const gateway = {
      getIvaCondition: async () => "ri" as const,
      ultimoAutorizado: async () => latestCalls++ === 0 ? 0 : 1,
      consultInvoice: async () => {
        consultCalls += 1;
        return { cbteNro: 1, cae: "70000000000001", caeFchVto: "2026-11-08" };
      },
      issueInvoice: async () => { throw new Error("must not dispatch an already-authorized number"); },
    };
    const result = await emitComprobante({ db: handle.db, gateway, environment: "homologacion", env: { EMISSIONS_ENABLED: "true", ARCA_ENV: "homologacion" }, now }, input(empresa, "advanced-before-dispatch"));
    expect(result).toMatchObject({ estado: "aprobado", cbteNro: 1, cae: "70000000000001", emitted: false });
    expect(consultCalls).toBe(1);
  });

  it("rejects an idempotency key whose persisted fiscal tuple differs", async () => {
    const empresa = await company();
    await insertDraft(empresa, "tuple-conflict", { estado: "rechazado", cbteNro: 7, ptoVta: 2 });
    await expect(emitComprobante({ db: handle.db, gateway: new ArcaGatewayFake(undefined, now), environment: "homologacion", env: { EMISSIONS_ENABLED: "true", ARCA_ENV: "homologacion" }, now }, input(empresa, "tuple-conflict")))
      .rejects.toThrow(IDEMPOTENCY_CONFLICT_REASON);
  });

  it("does not silently emit or return an existing borrador", async () => {
    const empresa = await company();
    const draft = await insertDraft(empresa, "existing-draft");
    let issueCalls = 0;
    const base = new ArcaGatewayFake(undefined, now);
    const gateway = {
      getIvaCondition: base.getIvaCondition.bind(base),
      ultimoAutorizado: base.ultimoAutorizado.bind(base),
      consultInvoice: base.consultInvoice.bind(base),
      issueInvoice: async (...args: Parameters<typeof base.issueInvoice>) => { issueCalls += 1; return base.issueInvoice(...args); },
    };
    await expect(emitComprobante({ db: handle.db, gateway, environment: "homologacion", env: { EMISSIONS_ENABLED: "true", ARCA_ENV: "homologacion" }, now }, input(empresa, "existing-draft")))
      .rejects.toThrow("borrador");
    expect(issueCalls).toBe(0);
    const [persisted] = await handle.db.select().from(comprobantes);
    expect(persisted!.id).toBe(draft.id);
    expect(persisted!.estado).toBe("borrador");
  });

  it("commits earlier orphan outcomes when a later reconciliation consult fails", async () => {
    const empresa = await company();
    await insertDraft(empresa, "orphan-approved", { estado: "incierto", cbteNro: 1 });
    await insertDraft(empresa, "orphan-fails", { estado: "incierto", cbteNro: 2 });
    const gateway = {
      getIvaCondition: async () => "ri" as const,
      ultimoAutorizado: async () => 2,
      consultInvoice: async (request: Parameters<NonNullable<ArcaGatewayFake["consultInvoice"]>>[0]) => {
        if (request.cbteNro === 2) throw new Error("consult timeout");
        return { cae: "70000000000001", caeFchVto: "2026-11-08", cbteNro: 1 };
      },
      issueInvoice: async () => { throw new Error("must not issue while reconciliation is uncertain"); },
    };
    await expect(emitComprobante({ db: handle.db, gateway, environment: "homologacion", env: { EMISSIONS_ENABLED: "true", ARCA_ENV: "homologacion" }, now }, input(empresa, "new-after-orphans")))
      .rejects.toThrow(RECONCILIATION_UNCERTAIN_REASON);
    const rows = await handle.db.select().from(comprobantes);
    expect(rows.find((row) => row.idempotencyKey === "orphan-approved")).toMatchObject({ estado: "aprobado", cae: "70000000000001" });
    expect(rows.find((row) => row.idempotencyKey === "orphan-fails")).toMatchObject({ estado: "incierto", errores: RECONCILIATION_UNCERTAIN_REASON });
  });
});
