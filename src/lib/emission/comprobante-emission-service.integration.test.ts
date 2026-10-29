import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { ArcaGateway, FECAEReq, IssueInvoiceResult } from "@/ports/arca-gateway";
import * as schema from "@/lib/db/schema";
import { clients, comprobantes, emissionSeriesClaims } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { emitComprobante, recoverSeriesClaim } from "./comprobante-emission-service";
import { acquireSeriesClaim, seriesKey, SERIES_LEASE_MS } from "./series-claim";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("comprobante emission against real Postgres", () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let companyId: string;
  let companyCuit: string;
  const now = () => new Date("2026-10-29T12:00:00Z");

  class SimulatedGateway implements ArcaGateway {
    private last = 0;
    private readonly issued = new Map<number, IssueInvoiceResult>();
    simultaneous = 0;
    maxSimultaneous = 0;
    async getIvaCondition() { return "ri" as const; }
    async ultimoAutorizado() { return this.last; }
    async consultInvoice(request: FECAEReq) { return this.issued.get(request.cbteNro) ?? null; }
    async issueInvoice(request: FECAEReq, beforeDispatch?: () => Promise<void>) {
      await beforeDispatch?.();
      this.simultaneous += 1;
      this.maxSimultaneous = Math.max(this.maxSimultaneous, this.simultaneous);
      await new Promise((resolve) => setTimeout(resolve, 10));
      try {
        if (request.cbteNro !== this.last + 1) throw new Error("sequence collision");
        const result = { cbteNro: request.cbteNro, cae: String(70000000000000 + request.cbteNro).padStart(14, "0"), caeFchVto: "2026-11-08" };
        this.issued.set(request.cbteNro, result);
        this.last = request.cbteNro;
        return result;
      } finally { this.simultaneous -= 1; }
    }
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 5 });
    db = drizzle(pool, { schema });
    companyCuit = `20${String(Date.now()).slice(-9)}`;
    const [company] = await db.insert(clients).values({ cuit: companyCuit, razonSocial: `Integration ${Date.now()}`, ptoVta: 1, condicionIva: "ri" }).returning();
    companyId = company!.id;
  });
  afterAll(async () => {
    if (companyId) {
      await db.delete(comprobantes).where(eq(comprobantes.empresaId, companyId));
      await db.delete(clients).where(eq(clients.id, companyId));
      await db.delete(emissionSeriesClaims).where(eq(emissionSeriesClaims.seriesKey, seriesKey("homologacion", companyCuit, 1, 1)));
      await db.delete(emissionSeriesClaims).where(eq(emissionSeriesClaims.seriesKey, seriesKey("homologacion", companyCuit, 1, 11)));
    }
    await pool.end();
  });
  function input(key: string) {
    return { empresaId: companyId, idempotencyKey: key, emisorCuit: companyCuit, emisorCondicionIva: "ri" as const, cbteTipo: 1 as const, ptoVta: 1, concepto: 1 as const, docTipo: 99, docNro: "0", condicionIvaReceptor: 5, fecha: "2026-10-29", importeNetoCentavos: 100, importeIvaCentavos: 21, importeExentoCentavos: 0, importeTributosCentavos: 0, importeTotalCentavos: 121, items: [{ descripcion: "Integration", netoCentavos: 100, ivaCentavos: 21, exentoCentavos: 0, tributosCentavos: 0, totalCentavos: 121, alicuota: 21 as const }] };
  }
  it("serializes five concurrent emissions and keeps consecutive numbers", async () => {
    const gateway = new SimulatedGateway();
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => emitComprobante({ db, gateway, environment: "homologacion", now }, input(`integration-${i}`))));
    expect(results.map((result) => result.cbteNro).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([1, 2, 3, 4, 5]);
    expect(gateway.maxSimultaneous).toBe(1);
  });
  it("keeps a crashed owner blocked until explicit recovery", async () => {
    const key = seriesKey("homologacion", companyCuit, 1, 11);
    expect(await acquireSeriesClaim(db, key, "crashed-owner", now().getTime() - SERIES_LEASE_MS - 1)).toBe(true);
    expect(await acquireSeriesClaim(db, key, "replacement", Date.now())).toBe(false);
    const gateway = new SimulatedGateway();
    await recoverSeriesClaim({ db, gateway, environment: "homologacion", now, uncertainGraceMs: 0 }, { key, environment: "homologacion", emisorCuit: companyCuit, ptoVta: 1, cbteTipo: 11 });
    expect(await acquireSeriesClaim(db, key, "replacement", Date.now())).toBe(true);
    await db.delete(emissionSeriesClaims).where(eq(emissionSeriesClaims.seriesKey, key));
  });
});
