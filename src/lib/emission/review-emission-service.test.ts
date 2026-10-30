import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "@/test-support/test-db";
import { clients, batches, photos, ocrRows, comprobantes, issuedInvoices } from "@/lib/db/schema";
import { ArcaGatewayFake } from "@/adapters/arca/arca-gateway.fake";
import { materializeInvoice, markInvoiceReviewed, approveInvoice } from "@/lib/review/workflow";
import { emitReviewedBatch, emitReviewedInvoice, reviewEmissionInput } from "./review-emission-service";
import { matchesApprovalSnapshot } from "@/domain/approval-snapshot";

describe("review uses canonical emission", () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  const now = () => new Date("2026-10-29T12:00:00Z");
  const env = { EMISSIONS_ENABLED: "true", ARCA_ENV: "homologacion" };
  beforeAll(async () => { handle = await createTestDb(); });
  afterAll(async () => { await handle.close(); });
  it("replays one approved review invoice with a stable key and fallback item", async () => {
    const db = handle.db;
    const gateway = new ArcaGatewayFake(undefined, now);
    const [company] = await db.insert(clients).values({ cuit: "20123456786", razonSocial: "Empresa de prueba", condicionIva: "exento", ptoVta: 1 }).returning();
    const [batch] = await db.insert(batches).values({ clientId: company!.id }).returning();
    const [photo] = await db.insert(photos).values({ batchId: batch!.id, storageKey: "test.png" }).returning();
    const [row] = await db.insert(ocrRows).values({ photoId: photo!.id, recipientMode: "consumer_final", fields: { name: "Venta revisada", amount: 100000, date: "2026-10-29" }, confidence: {}, status: "CORRECTED" }).returning();
    const invoice = await materializeInvoice(db, row!.id);
    await markInvoiceReviewed(db, invoice.id);
    await approveInvoice(db, gateway, invoice.id, now, undefined, "homologacion");
    const replay = await approveInvoice(db, gateway, invoice.id, () => new Date("2026-10-30T12:00:00Z"), undefined, "homologacion");
    expect(replay.status).toBe("APPROVED");
    expect(replay.fechaEmision).toBe("2026-10-29");
    const deps = { db, gateway, now, env, environment: "homologacion" as const };
    const input = await reviewEmissionInput(deps, invoice.id);
    const snapshot = replay.approvalSnapshot!;
    expect(matchesApprovalSnapshot({ ...snapshot, itemSnapshot: "[]" }, snapshot)).toBe(false);
    expect(matchesApprovalSnapshot(snapshot, { ...snapshot, itemSnapshot: "[]" })).toBe(false);
    expect(input.idempotencyKey).toBe(`invoice:${invoice.id}:approve`);
    expect(input.items).toEqual([{ descripcion: "Venta revisada", netoCentavos: 100000, ivaCentavos: 0, exentoCentavos: 0, tributosCentavos: 0, totalCentavos: 100000, alicuota: 0 }]);
    const first = await emitReviewedInvoice(deps, invoice.id);
    const second = await emitReviewedInvoice(deps, invoice.id);
    expect(first.estado).toBe("aprobado");
    expect(second.id).toBe(first.id);
    expect(second.emitted).toBe(false);
    expect(await db.select().from(comprobantes)).toHaveLength(1);
    expect(await db.select().from(issuedInvoices)).toHaveLength(0);
    const batchResults = await emitReviewedBatch(deps, [crypto.randomUUID(), invoice.id]);
    expect(batchResults.map(result => result.outcome)).toEqual(["failed_transient", "already_emitted"]);
  });
});

