import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test-support/test-db";
import {
  auditLog,
  batches,
  clients,
  delegations,
  invoices,
  issuedInvoices,
  ocrRows,
  payers,
  photos,
} from "@/lib/db/schema";
import { ArcaGatewayFake, CAE_BASE } from "@/adapters/arca/arca-gateway.fake";
import {
  approveInvoice,
  markInvoiceReviewed,
  materializeInvoice,
} from "@/lib/review/workflow";
import { RowNotEmittableError } from "@/domain/emission";
import {
  ArcaBusinessError,
  ArcaTransientError,
} from "@/adapters/arca/errors";
import {
  emitBatch,
  emitInvoice,
  EmissionError,
  listRecoverableInvoiceIds,
  NumberAllocator,
  recoverStuckEmissions,
  ReservationCollisionError,
} from "./emission-service";
import type { ArcaGateway, FECAEReq, IssueInvoiceResult } from "@/ports/arca-gateway";
import type { CbteTipo } from "@/domain/policy";
import type { Db } from "@/lib/db/types";
import { parseFecaesolicitarResponse } from "@/adapters/arca/wsfe";
import { WsfeClient } from "@/adapters/arca/wsfe";
import { ArcaGatewayProd } from "@/adapters/arca/arca-gateway.prod";
import { PadronA5Client } from "@/adapters/arca/padron";

const FIXED_DATE = new Date("2026-09-22T00:00:00.000Z");
const MONOTRIBUTISTA = "30710145764";

/** Wraps the fake to count ultimoAutorizado / issueInvoice calls. */
class CountingGateway implements ArcaGateway {
  ultimoAutorizadoCalls = 0;
  issueCalls: number[] = [];

  constructor(private readonly inner: ArcaGateway) {}

  getIvaCondition(c: string, p: string) {
    return this.inner.getIvaCondition(c, p);
  }
  async ultimoAutorizado(c: string, p: number, t: CbteTipo) {
    this.ultimoAutorizadoCalls += 1;
    return this.inner.ultimoAutorizado(c, p, t);
  }
  async issueInvoice(r: FECAEReq) {
    this.issueCalls.push(r.cbteNro);
    return this.inner.issueInvoice(r);
  }
}

/** A gateway that emits at ARCA but LOSES the response on the next call. */
class LostResponseGateway implements ArcaGateway {
  private readonly last = new Map<string, number>();
  issueCalls: number[] = [];
  loseNext = false;

  async getIvaCondition(): Promise<"ri"> {
    return "ri";
  }
  async ultimoAutorizado(c: string, p: number, t: number) {
    return this.last.get(`${c}:${p}:${t}`) ?? 0;
  }
  async issueInvoice(r: FECAEReq): Promise<IssueInvoiceResult> {
    this.issueCalls.push(r.cbteNro);
    const sk = `${r.cuit}:${r.ptoVta}:${r.cbteTipo}`;
    // ARCA accepts and records the emission…
    this.last.set(sk, r.cbteNro);
    if (this.loseNext) {
      this.loseNext = false;
      throw new Error("network failure after ARCA accepted (lost response)");
    }
    return {
      cae: String(CAE_BASE + r.cbteNro).padStart(14, "0"),
      caeFchVto: "2026-10-02",
      cbteNro: r.cbteNro,
    };
  }
}

/** A gateway that throws a typed ARCA error on the Nth `issueInvoice` call. */
class ThrowingGateway implements ArcaGateway {
  private calls = 0;

  constructor(
    private readonly inner: ArcaGateway,
    private readonly throwOnCall: number,
    private readonly error: Error,
  ) {}

  getIvaCondition(c: string, p: string) {
    return this.inner.getIvaCondition(c, p);
  }
  ultimoAutorizado(c: string, p: number, t: CbteTipo) {
    return this.inner.ultimoAutorizado(c, p, t);
  }
  async issueInvoice(r: FECAEReq): Promise<IssueInvoiceResult> {
    this.calls += 1;
    if (this.calls === this.throwOnCall) throw this.error;
    return this.inner.issueInvoice(r);
  }
}

describe("emission service — idempotency reservation + status machine", () => {
  let db: Db;
  let close: () => Promise<void>;
  let approveGateway: ArcaGatewayFake;
  let clientId: string;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    approveGateway = new ArcaGatewayFake(undefined, () => FIXED_DATE);
    const [client] = await db
      .insert(clients)
      .values({
        cuit: "20123456789",
        razonSocial: "EMISOR RI S.A.",
        ptoVta: 1,
        condicionIva: "ri",
      })
      .returning();
    clientId = client!.id;
  });

  beforeEach(async () => {
    await db.delete(auditLog);
    await db.delete(issuedInvoices);
    await db.delete(invoices);
    await db.delete(delegations);
    await db.delete(ocrRows);
    await db.delete(photos);
    await db.delete(batches);
    await db.delete(payers);
  });

  afterAll(async () => {
    await close();
  });

  it("keeps malformed issuance terminal and reserved with an explicitly uncertain outcome", async () => {
    await seedDelegation(true);
    const { invoiceId } = await seedApprovedInvoice();
    let uncertain: Error | undefined;
    try { parseFecaesolicitarResponse("<Envelope/>"); } catch (error) { uncertain = error as Error; }
    expect(uncertain).toBeInstanceOf(ArcaBusinessError);
    const gateway = new ThrowingGateway(new ArcaGatewayFake(undefined, () => FIXED_DATE), 1, uncertain!);
    const [result] = await emitBatch(deps(gateway), [invoiceId]);
    expect(result).toMatchObject({ outcome: "failed_permanent", stage: "issuance", category: "malformed-response" });
    expect(result!.error).toContain("outcome uncertain");
    expect((await db.select().from(invoices).where(eq(invoices.id, invoiceId)))[0]!.status).toBe("EMIT_FAILED");
    expect(await db.select().from(issuedInvoices).where(eq(issuedInvoices.invoiceId, invoiceId))).toEqual([expect.objectContaining({ cbteNro: 1, cae: null })]);
    expect(await listRecoverableInvoiceIds(db)).not.toContain(invoiceId);
  });

  it("holds an Errors-only number conflict with malformed consultation through the full gateway/service path", async () => {
    await seedDelegation(true);
    const { invoiceId } = await seedApprovedInvoice();
    const operations: string[] = [];
    const gateway = new ArcaGatewayProd({
      emissionsEnabled: true,
      taCache: { get: async () => ({ token: "TOKEN", sign: "SIGN", expirationTime: "2026-09-23T00:00:00Z" }), evict: async () => {} },
      padron: new PadronA5Client({ url: "offline", transport: { post: async () => { throw new Error("Unexpected padron query"); } } }),
      wsfe: new WsfeClient({ url: "offline", transport: { post: async (_url, body) => {
        if (body.includes("<ar:FECompUltimoAutorizado>")) { operations.push("ultimo"); return "<Envelope><Body><FECompUltimoAutorizadoResponse><FECompUltimoAutorizadoResult><CbteNro>0</CbteNro></FECompUltimoAutorizadoResult></FECompUltimoAutorizadoResponse></Body></Envelope>"; }
        if (body.includes("<ar:FECAESolicitar>")) { operations.push("issuance"); return "<Envelope><Body><FECAESolicitarResponse><FECAESolicitarResult><Errors><Err><Code>10016</Code><Msg>SECRET_TOKEN</Msg></Err></Errors></FECAESolicitarResult></FECAESolicitarResponse></Body></Envelope>"; }
        operations.push("consultation"); return "<Envelope/>";
      } } }),
    });
    const [result] = await emitBatch(deps(gateway), [invoiceId]);
    expect(result).toMatchObject({ outcome: "failed_permanent", stage: "issuance", category: "malformed-response" });
    expect(result!.error).toContain("outcome uncertain");
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(operations).toEqual(["ultimo", "issuance", "consultation"]);
    expect((await db.select().from(invoices).where(eq(invoices.id, invoiceId)))[0]!.status).toBe("EMIT_FAILED");
    expect(await db.select().from(issuedInvoices).where(eq(issuedInvoices.invoiceId, invoiceId))).toEqual([expect.objectContaining({ cbteNro: 1, cae: null })]);
    expect(await listRecoverableInvoiceIds(db)).not.toContain(invoiceId);
  });

  /** Seeds a delegation row for the client, or none when `enabled` is undefined. */
  async function seedDelegation(enabled: boolean | undefined) {
    if (enabled === undefined) return;
    await db
      .insert(delegations)
      .values({ clientId, cuit: "20123456789", enabled });
  }

  /** Seeds a fully APPROVED invoice (via the workflow), returns its id. */
  async function seedApprovedInvoice(payerCuit: string | null = MONOTRIBUTISTA) {
    const [batch] = await db
      .insert(batches)
      .values({ clientId })
      .returning();
    const [photo] = await db
      .insert(photos)
      .values({ batchId: batch!.id, storageKey: "k.jpg" })
      .returning();
    const [row] = await db
      .insert(ocrRows)
      .values({recipientMode:"identified",taxRate:21,
        photoId: photo!.id,
        fields: { name: "PAGADOR S.A.", amount: 121000, date: "2026-09-22" },
        confidence: { name: 0.9, amount: 0.9 },
        cuit: payerCuit,
        status: "CORRECTED",
      })
      .returning();
    const inv = await materializeInvoice(db, row!.id);
    await markInvoiceReviewed(db,inv.id);
    await approveInvoice(db, approveGateway, inv.id, () => FIXED_DATE);
    return { invoiceId: inv.id, rowId: row!.id };
  }

  const deps = (gateway: ArcaGateway, emissionsEnabled = true) => ({
    db,
    gateway,
    emissionsEnabled,
    delayMs: 0,
  });

  it("ultimo rejection is safe and permanent before reservation; explicit retry uses the same approved invoice", async () => {
    await seedDelegation(true);
    const { invoiceId } = await seedApprovedInvoice();
    const gateway = new CountingGateway(new ArcaGatewayFake(undefined, () => FIXED_DATE));
    const original = gateway.ultimoAutorizado.bind(gateway);
    gateway.ultimoAutorizado = async () => {
      throw new ArcaBusinessError("ARCA ultimo failed (provider-errors, code=11002)", {
        code: "11002", stage: "ultimo", category: "provider-errors", providerCodes: [11002],
      });
    };
    expect(await emitBatch(deps(gateway), [invoiceId])).toEqual([expect.objectContaining({
      outcome: "failed_permanent", stage: "ultimo", category: "provider-errors", arcaCode: "11002", providerCodes: [11002],
    })]);
    expect(await db.select().from(issuedInvoices)).toEqual([]);
    expect(gateway.issueCalls).toEqual([]);
    expect((await db.select().from(invoices).where(eq(invoices.id, invoiceId)))[0]!.status).toBe("APPROVED");
    expect(await listRecoverableInvoiceIds(db)).toEqual([]);
    gateway.ultimoAutorizado = original;
    expect(await emitBatch(deps(gateway), [invoiceId])).toEqual([expect.objectContaining({ outcome: "emitted", cbteNro: 1 })]);
    expect(gateway.issueCalls).toEqual([1]);
  });

  it("reports issuance rather than ultimo and strips unsafe typed error messages", async () => {
    await seedDelegation(true);
    const { invoiceId } = await seedApprovedInvoice();
    const gateway = new ThrowingGateway(new ArcaGatewayFake(undefined, () => FIXED_DATE), 1,
      new ArcaBusinessError("SECRET_RAW_SOAP", { code: "10049" }));
    const [result] = await emitBatch(deps(gateway), [invoiceId]);
    expect(result).toMatchObject({ outcome: "failed_permanent", stage: "issuance", category: "provider-errors", arcaCode: "10049" });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain("SECRET");
  });

  it.each([NaN, -1, 1.5, Infinity, 100_000_000])("does not reserve an invalid provider number %s", async number => {
    await seedDelegation(true);
    const { invoiceId } = await seedApprovedInvoice();
    const gateway = new CountingGateway(new ArcaGatewayFake(undefined, () => FIXED_DATE));
    gateway.ultimoAutorizado = async () => number;
    expect(await emitBatch(deps(gateway), [invoiceId])).toEqual([expect.objectContaining({ outcome: "failed_permanent", stage: "ultimo", category: "malformed-response" })]);
    expect(await db.select().from(issuedInvoices)).toEqual([]);
    expect(gateway.issueCalls).toEqual([]);
  });

  it("happy path: reserves, emits once, persists the 14-digit CAE, marks EMITTED", async () => {
    await seedDelegation(true);
    const { invoiceId } = await seedApprovedInvoice();

    const result = await emitInvoice(
      deps(new ArcaGatewayFake(undefined, () => FIXED_DATE)),
      new NumberAllocator(new ArcaGatewayFake(undefined, () => FIXED_DATE)),
      invoiceId,
    );

    expect(result.emitted).toBe(true);
    expect(result.cbteNro).toBe(1); // ultimoAutorizado 0 → 1
    expect(result.cae).toHaveLength(14);

    const [reservation] = await db
      .select()
      .from(issuedInvoices)
      .where(eq(issuedInvoices.invoiceId, invoiceId));
    expect(reservation!.cae).toBe(result.cae);
    expect(reservation!.cbteNro).toBe(1);

    const [invoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    expect(invoice!.status).toBe("EMITTED");

    // C5: the attempt and CAE persistence are audited.
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.invoiceId, invoiceId));
    expect(audits.some((a) => a.action === "emission.attempt")).toBe(true);
    expect(audits.some((a) => a.action === "emission.cae_persisted")).toBe(true);
  });

  it("allocates the number ONCE per (cuit,ptoVta,cbteTipo) and increments locally", async () => {
    await seedDelegation(true);
    const a = await seedApprovedInvoice();
    const b = await seedApprovedInvoice();
    const counting = new CountingGateway(new ArcaGatewayFake(undefined, () => FIXED_DATE));

    const results = await emitBatch(
      { ...deps(counting) },
      [a.invoiceId, b.invoiceId],
    );

    expect(results.map((r) => r.cbteNro)).toEqual([1, 2]);
    // FECompUltimoAutorizado queried exactly once (not once per invoice).
    expect(counting.ultimoAutorizadoCalls).toBe(1);
    // Emitted serially in order.
    expect(counting.issueCalls).toEqual([1, 2]);
  });

  it("lost-response retry replays the SAME cbteNro and never emits a second invoice", async () => {
    await seedDelegation(true);
    const { invoiceId } = await seedApprovedInvoice();
    const gateway = new LostResponseGateway();
    gateway.loseNext = true;

    const allocator = new NumberAllocator(gateway);
    // Attempt 1: ARCA accepts but the response is lost.
    await expect(emitInvoice(deps(gateway), allocator, invoiceId)).rejects.toThrow(
      /ARCA issuance failed \(internal\)/,
    );

    // Recoverable: reservation pinned cbteNro 1, invoice EMIT_ERROR.
    const [afterFail] = await db
      .select()
      .from(issuedInvoices)
      .where(eq(issuedInvoices.invoiceId, invoiceId));
    expect(afterFail!.cbteNro).toBe(1);
    expect(afterFail!.cae).toBeNull();
    const [failedInvoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    expect(failedInvoice!.status).toBe("EMIT_ERROR");

    // Attempt 2 (retry): replay the SAME number, recover the CAE.
    const result = await emitInvoice(deps(gateway), allocator, invoiceId);
    expect(result.cbteNro).toBe(1);
    expect(result.emitted).toBe(true);

    // The gateway saw the SAME number both times (never an incremented 2).
    expect(gateway.issueCalls).toEqual([1, 1]);

    const rows = await db.select().from(issuedInvoices);
    expect(rows).toHaveLength(1); // still ONE reservation — no second invoice
    expect(rows[0]!.cae).toHaveLength(14);

    const [invoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    expect(invoice!.status).toBe("EMITTED");
  });

  it("recovers from a DB failure after ARCA accepted (pinned number makes it replayable)", async () => {
    await seedDelegation(true);
    const { invoiceId } = await seedApprovedInvoice();
    const gateway = new ArcaGatewayFake(undefined, () => FIXED_DATE);

    // Simulate "ARCA emitted cbteNro 5 but the DB write of the CAE failed":
    // ARCA knows the number (record it), but our reservation has no CAE.
    await gateway.issueInvoice({
      cuit: "20123456789",
      ptoVta: 1,
      cbteTipo: 1,
      cbteNro: 5,
      receptorDocTipo: 80,
      receptorDocNro: Number(MONOTRIBUTISTA),
      condicionIvaReceptorId: 6,
      receptorRazonSocial: "PAGADOR S.A.",
      fechaEmision: "2026-09-22",
      fechaVto: "2026-09-22",
      moneda: "PES",
      cotizacion: 1,
      importeNeto: 100000,
      importeIva: 21000,
      importeTotal: 121000,
    });
    await db.insert(issuedInvoices).values({
      invoiceId,
      cuit: "20123456789",
      ptoVta: 1,
      cbteTipo: 1,
      cbteNro: 5,
      cae: null,
      caeFchVto: null,
      importeTotalCentavos: 121000,
    });
    await db
      .update(invoices)
      .set({ status: "EMIT_ERROR" })
      .where(eq(invoices.id, invoiceId));

    const result = await emitInvoice(
      deps(gateway),
      new NumberAllocator(gateway),
      invoiceId,
    );

    // Recovered WITHOUT deriving a new number (still 5, not 6).
    expect(result.cbteNro).toBe(5);
    const rows = await db.select().from(issuedInvoices);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cae).toHaveLength(14);
    const [invoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    expect(invoice!.status).toBe("EMITTED");
  });

  it("the unique idempotency index rejects a second row with the same (cuit,ptoVta,cbteTipo,cbteNro)", async () => {
    await seedDelegation(true);
    const { invoiceId } = await seedApprovedInvoice();
    const base = {
      invoiceId,
      cuit: "20123456789",
      ptoVta: 1,
      cbteTipo: 1,
      cbteNro: 3,
      cae: "70000000000003",
      caeFchVto: "2026-10-02",
      importeTotalCentavos: 121000,
    };
    await db.insert(issuedInvoices).values(base);
    await expect(
      db.insert(issuedInvoices).values({ ...base, cae: "70000000000099" }),
    ).rejects.toThrow();
  });

  it("a second emit of an already-emitted invoice is a no-op (no duplicate row)", async () => {
    await seedDelegation(true);
    const { invoiceId } = await seedApprovedInvoice();
    const gateway = new ArcaGatewayFake(undefined, () => FIXED_DATE);
    const allocator = new NumberAllocator(gateway);

    const first = await emitInvoice(deps(gateway), allocator, invoiceId);
    const second = await emitInvoice(deps(gateway), allocator, invoiceId);

    expect(first.emitted).toBe(true);
    expect(second.emitted).toBe(false); // idempotent replay
    expect(second.cbteNro).toBe(first.cbteNro);
    expect(second.cae).toBe(first.cae);
    expect(await db.select().from(issuedInvoices)).toHaveLength(1);
  });

  it("4.B wired guard: the emission service rejects a BLOCKED row", async () => {
    await seedDelegation(true);
    // An APPROVED invoice whose OCR row was subsequently re-blocked.
    const [batch] = await db
      .insert(batches)
      .values({ clientId })
      .returning();
    const [photo] = await db
      .insert(photos)
      .values({ batchId: batch!.id, storageKey: "k.jpg" })
      .returning();
    const [row] = await db
      .insert(ocrRows)
      .values({recipientMode:"identified",taxRate:21,
        photoId: photo!.id,
        fields: { name: "PAGADOR", amount: 121000, date: "2026-09-22" },
        confidence: { name: 0.5 }, // below threshold → BLOCKED
        cuit: MONOTRIBUTISTA,
        status: "BLOCKED",
      })
      .returning();
    const inv = await materializeInvoice(db, row!.id); // PENDING
    // Force the invoice into APPROVED to isolate the ROW guard (data-integrity edge).
    await db
      .update(invoices)
      .set({ status: "APPROVED", cbteTipo: 1 })
      .where(eq(invoices.id, inv.id));

    const gateway = new ArcaGatewayFake(undefined, () => FIXED_DATE);
    await expect(
      emitInvoice(deps(gateway), new NumberAllocator(gateway), inv.id),
    ).rejects.toThrow(RowNotEmittableError);
  });

  it("4.B wired guard: the emission service rejects a REJECTED invoice", async () => {
    await seedDelegation(true);
    const { invoiceId } = await seedApprovedInvoice();
    await db
      .update(invoices)
      .set({ status: "REJECTED", discardReason: "non-sale" })
      .where(eq(invoices.id, invoiceId));

    const gateway = new ArcaGatewayFake(undefined, () => FIXED_DATE);
    await expect(
      emitInvoice(deps(gateway), new NumberAllocator(gateway), invoiceId),
    ).rejects.toThrow(EmissionError);
  });

  it("4.D delegation: refuses a client with no delegation row", async () => {
    // seedDelegation intentionally skipped.
    const { invoiceId } = await seedApprovedInvoice();
    const gateway = new ArcaGatewayFake(undefined, () => FIXED_DATE);
    await expect(
      emitInvoice(deps(gateway), new NumberAllocator(gateway), invoiceId),
    ).rejects.toThrow(/no enabled wsfe delegation/);
    // Nothing reserved.
    expect(await db.select().from(issuedInvoices)).toHaveLength(0);
  });

  it("4.D delegation: refuses a client whose delegation is disabled", async () => {
    await seedDelegation(false);
    const { invoiceId } = await seedApprovedInvoice();
    const gateway = new ArcaGatewayFake(undefined, () => FIXED_DATE);
    await expect(
      emitInvoice(deps(gateway), new NumberAllocator(gateway), invoiceId),
    ).rejects.toThrow(/no enabled wsfe delegation/);
  });

  it("4.E EMISSIONS_ENABLED: the batch refuses to reserve any number when disabled", async () => {
    await seedDelegation(true);
    const { invoiceId } = await seedApprovedInvoice();
    const gateway = new ArcaGatewayFake(undefined, () => FIXED_DATE);
    await expect(
      emitBatch({ ...deps(gateway, false) }, [invoiceId]),
    ).rejects.toThrow(/disabled/);
    expect(await db.select().from(issuedInvoices)).toHaveLength(0);
  });

  it("recoverStuckEmissions replays an EMITTING/EMIT_ERROR row with a NULL CAE (job-level recovery)", async () => {
    await seedDelegation(true);
    const { invoiceId } = await seedApprovedInvoice();
    const gateway = new ArcaGatewayFake(undefined, () => FIXED_DATE);

    // Simulate a crash AFTER reservation but BEFORE the CAE was persisted:
    // the reservation pins cbteNro 4 but has NULL CAE and the invoice is
    // stuck in EMIT_ERROR — exactly what the recovery sweeper must re-drive.
    await db.insert(issuedInvoices).values({
      invoiceId,
      cuit: "20123456789",
      ptoVta: 1,
      cbteTipo: 1,
      cbteNro: 4,
      cae: null,
      caeFchVto: null,
      importeTotalCentavos: 121000,
    });
    await db
      .update(invoices)
      .set({ status: "EMIT_ERROR" })
      .where(eq(invoices.id, invoiceId));

    // The JOB-LEVEL recovery path (not a direct emitInvoice call).
    const results = await recoverStuckEmissions(deps(gateway));

    expect(results).toHaveLength(1);
    expect(results[0]!.outcome).toBe("emitted");
    expect(results[0]!.cbteNro).toBe(4); // replay the pinned number, NOT a fresh 5
    const rows = await db.select().from(issuedInvoices);
    expect(rows).toHaveLength(1); // still ONE reservation — no second invoice
    expect(rows[0]!.cae).toHaveLength(14);
    const [invoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    expect(invoice!.status).toBe("EMITTED");
  });

  it("the unique invoice_id index rejects a second reservation for the SAME invoice (concurrency guard)", async () => {
    await seedDelegation(true);
    const { invoiceId } = await seedApprovedInvoice();
    const base = {
      invoiceId,
      cuit: "20123456789",
      ptoVta: 1,
      cbteTipo: 1,
      cbteNro: 10,
      cae: null,
      caeFchVto: null,
      importeTotalCentavos: 121000,
    };
    await db.insert(issuedInvoices).values(base);
    // A concurrent run of the SAME invoice tries a DIFFERENT number — the
    // invoice_id unique index must reject it before ARCA is ever contacted.
    await expect(
      db.insert(issuedInvoices).values({ ...base, cbteNro: 11 }),
    ).rejects.toThrow();
  });

  it("W2: a permanent rejection is recorded per-row and never aborts the batch or re-queued", async () => {
    await seedDelegation(true);
    const a = await seedApprovedInvoice();
    const b = await seedApprovedInvoice();
    const base = new ArcaGatewayFake(undefined, () => FIXED_DATE);
    // First emit fails PERMANENTLY (ARCA business rejection); second succeeds.
    const gateway = new ThrowingGateway(
      base,
      1,
      new ArcaBusinessError("ARCA rejected the comprobante", { code: "10049" }),
    );

    const results = await emitBatch(deps(gateway), [a.invoiceId, b.invoiceId]);

    // Per-row isolation: the batch continues past the permanent failure.
    expect(results[0]!.outcome).toBe("failed_permanent");
    expect(results[0]!.arcaCode).toBe("10049");
    expect(results[1]!.outcome).toBe("emitted");

    // Permanent → terminal EMIT_FAILED, NEVER re-queued by the recovery sweeper.
    const [failedInvoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.id, a.invoiceId));
    expect(failedInvoice!.status).toBe("EMIT_FAILED");
    const recoverable = await listRecoverableInvoiceIds(db);
    expect(recoverable).not.toContain(a.invoiceId);

    // C5: the failure is audited as emission.error with the permanent kind.
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.invoiceId, a.invoiceId));
    expect(
      audits.some(
        (x) =>
          x.action === "emission.error" &&
          (x.payload as { kind?: string } | null)?.kind === "permanent",
      ),
    ).toBe(true);
  });

  it("W2: a transient failure is recorded as failed_transient and IS recoverable", async () => {
    await seedDelegation(true);
    const a = await seedApprovedInvoice();
    const b = await seedApprovedInvoice();
    const base = new ArcaGatewayFake(undefined, () => FIXED_DATE);
    const gateway = new ThrowingGateway(
      base,
      1,
      new ArcaTransientError("network timeout"),
    );

    const results = await emitBatch(deps(gateway), [a.invoiceId, b.invoiceId]);

    expect(results[0]!.outcome).toBe("failed_transient");
    expect(results[1]!.outcome).toBe("emitted");

    // Transient → EMIT_ERROR, re-queued by the recovery sweeper.
    const [failedInvoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.id, a.invoiceId));
    expect(failedInvoice!.status).toBe("EMIT_ERROR");
    const recoverable = await listRecoverableInvoiceIds(db);
    expect(recoverable).toContain(a.invoiceId);

    // C5: the transient failure is audited as emission.error with kind transient.
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.invoiceId, a.invoiceId));
    expect(
      audits.some(
        (x) =>
          x.action === "emission.error" &&
          (x.payload as { kind?: string } | null)?.kind === "transient",
      ),
    ).toBe(true);
  });

  it("W3: NumberAllocator seeds from max(local, ARCA) so a stale reservation is never re-allocated", async () => {
    // ARCA says 5 is the last authorized, but a local reservation already holds
    // 10 (crash after commit, before ARCA). The allocator MUST continue at 11,
    // never re-allocate ARCA's stale 6.
    const staleArca = {
      ultimoAutorizado: async () => 5,
    } as unknown as ArcaGateway;
    const allocator = new NumberAllocator(staleArca, async () => 10);
    expect(await allocator.next("20123456789", 1, 1)).toBe(11);

    // Triangulate the other direction: local 3 < ARCA 7 → continue at 8.
    const aheadArca = {
      ultimoAutorizado: async () => 7,
    } as unknown as ArcaGateway;
    const allocator2 = new NumberAllocator(aheadArca, async () => 3);
    expect(await allocator2.next("20123456789", 1, 1)).toBe(8);
  });

  it("W3: a reservation number collision surfaces as ReservationCollisionError (not a raw DB error) and leaves no orphan", async () => {
    await seedDelegation(true);
    const a = await seedApprovedInvoice();
    const b = await seedApprovedInvoice();

    // Invoice B already holds number 1 in the same (cuit,ptoVta,cbteTipo) key.
    await db.insert(issuedInvoices).values({
      invoiceId: b.invoiceId,
      cuit: "20123456789",
      ptoVta: 1,
      cbteTipo: 1,
      cbteNro: 1,
      cae: null,
      caeFchVto: null,
      importeTotalCentavos: 121000,
    });

    // A custom allocator that ignores the local max forces invoice A to pick
    // number 1 — the same number B already holds (a stale allocator / race).
    const gateway = new ArcaGatewayFake(undefined, () => FIXED_DATE);
    const allocator = new NumberAllocator(gateway, async () => 0);

    await expect(
      emitInvoice(deps(gateway), allocator, a.invoiceId),
    ).rejects.toThrow(ReservationCollisionError);

    // The reservation transaction rolled back — no orphan for invoice A.
    const rows = await db
      .select()
      .from(issuedInvoices)
      .where(eq(issuedInvoices.invoiceId, a.invoiceId));
    expect(rows).toHaveLength(0);
  });

  it("W3: a reservation collision surfaces as failed_collision (not failed_permanent) and does not abort the batch", async () => {
    await seedDelegation(true);
    const a = await seedApprovedInvoice();
    const b = await seedApprovedInvoice();
    const base = new ArcaGatewayFake(undefined, () => FIXED_DATE);
    // Drive the batch boundary with a ReservationCollisionError: `failureOf`
    // must classify it as failed_collision — NOT failed_permanent, which is
    // what the generic EmissionError classifier would otherwise produce.
    const gateway = new ThrowingGateway(
      base,
      1,
      new ReservationCollisionError(a.invoiceId, 1),
    );

    const results = await emitBatch(deps(gateway), [a.invoiceId, b.invoiceId]);

    expect(results[0]!.outcome).toBe("failed_collision");
    expect(results[1]!.outcome).toBe("emitted"); // the batch continues
  });
});
