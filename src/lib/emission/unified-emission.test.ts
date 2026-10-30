import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/test-support/test-db";
import { clients, batches, photos, ocrRows, comprobantes, issuedInvoices } from "@/lib/db/schema";
import { ArcaGatewayFake } from "@/adapters/arca/arca-gateway.fake";
import { materializeInvoice, markInvoiceReviewed, approveInvoice } from "@/lib/review/workflow";
import { emitReviewedBatch, emitReviewedInvoice, reviewEmissionInput } from "./review-emission-service";
import { emitComprobante } from "./comprobante-emission-service";
import { loadApprovedComprobantePdfInput } from "@/lib/invoices/read-model";
import { buildComprobantePdfModel, renderInvoicePdf } from "@/pdf/render";

describe("one fiscal pipeline for review and manual entry", () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  const now = () => new Date("2026-10-29T12:00:00Z");
  const env = { EMISSIONS_ENABLED: "true", ARCA_ENV: "homologacion" };
  beforeAll(async () => { handle = await createTestDb(); });
  afterAll(async () => { await handle.close(); });

  async function fixture(ptoVta: number) {
    const db = handle.db;
    const gateway = new ArcaGatewayFake(undefined, now);
    const [company] = await db.insert(clients).values({ cuit: "20123456786", razonSocial: "Emisor revisado", condicionIva: "exento", ptoVta }).onConflictDoUpdate({ target: clients.cuit, set: { ptoVta } }).returning();
    const [batch] = await db.insert(batches).values({ clientId: company!.id }).returning();
    const [photo] = await db.insert(photos).values({ batchId: batch!.id, storageKey: `test-${ptoVta}.png` }).returning();
    const [row] = await db.insert(ocrRows).values({ photoId: photo!.id, recipientMode: "consumer_final", fields: { name: "Servicio revisado", amount: 100000, date: "2026-10-29" }, confidence: {}, status: "CORRECTED" }).returning();
    const invoice = await materializeInvoice(db, row!.id);
    await markInvoiceReviewed(db, invoice.id);
    await approveInvoice(db, gateway, invoice.id, now, undefined, "homologacion");
    return { invoice, company: company!, deps: { db, gateway, now, env, environment: "homologacion" as const } };
  }

  it("reconciles a job retry after a lost successful response without another issuance", async () => {
    const { invoice, company, deps } = await fixture(21);
    const issue = vi.spyOn(deps.gateway, "issueInvoice");
    issue.mockImplementationOnce(async (request, beforeDispatch) => {
      await ArcaGatewayFake.prototype.issueInvoice.call(deps.gateway, request, beforeDispatch);
      throw new Error("response lost after authorization");
    });
    const first = await emitReviewedBatch(deps, [invoice.id]);
    expect(first[0]?.outcome).toBe("failed_transient");
    const retry = await emitReviewedBatch({ ...deps, now: () => new Date(now().getTime() + 80_000) }, [invoice.id]);
    expect(retry[0]?.outcome).toBe("already_emitted");
    expect(issue).toHaveBeenCalledTimes(1);
    expect((await handle.db.select().from(comprobantes)).filter(r => r.empresaId === company.id)).toHaveLength(1);
    const replay = await emitReviewedInvoice(deps, invoice.id);
    expect(replay.estado).toBe("aprobado");
    expect(replay.emitted).toBe(false);
  });

  it("double approval and duplicate jobs authorize exactly one comprobante", async () => {
    const { invoice, company, deps } = await fixture(24);
    await Promise.all([
      approveInvoice(handle.db, deps.gateway, invoice.id, now, undefined, "homologacion"),
      approveInvoice(handle.db, deps.gateway, invoice.id, now, undefined, "homologacion"),
    ]);
    const issue = vi.spyOn(deps.gateway, "issueInvoice");
    const [first, second] = await Promise.all([
      emitReviewedInvoice(deps, invoice.id), emitReviewedInvoice(deps, invoice.id),
    ]);
    expect(first.id).toBe(second.id);
    expect(issue).toHaveBeenCalledTimes(1);
    expect((await handle.db.select().from(comprobantes)).filter(r => r.empresaId === company.id && r.ptoVta === 24)).toHaveLength(1);
  });

  it("supports canonical credit notes and complete PDF for a reviewed invoice", async () => {
    const { invoice, company, deps } = await fixture(22);
    const result = await emitReviewedInvoice(deps, invoice.id);
    const input = await reviewEmissionInput(deps, invoice.id);
    const note = await emitComprobante(deps, { ...input, idempotencyKey: "review-credit", cbteTipo: 13, comprobanteAsociadoId: result.id });
    expect(note.estado).toBe("aprobado");
    expect((await handle.db.select().from(comprobantes)).find(r => r.id === note.id)?.comprobanteAsociadoId).toBe(result.id);
    const pdfInput = await loadApprovedComprobantePdfInput(handle.db, result.id, company.id);
    expect(pdfInput).not.toBeNull();
    const model = buildComprobantePdfModel(pdfInput!);
    expect(model.issuer).toEqual({ name: "Emisor revisado", cuit: company.cuit });
    expect(model.itemLines).toEqual([{ description: "Servicio revisado", amount: "1000.00" }]);
    expect(model.totals).toEqual([
      { label: "Neto", value: "1000.00" },
      { label: "IVA", value: "0.00" },
      { label: "Exento", value: "0.00" },
      { label: "Tributos", value: "0.00" },
      { label: "Total", value: "1000.00" },
    ]);
    const payload = JSON.parse(Buffer.from(new URL(model.qrUrl).searchParams.get("p")!, "base64").toString());
    expect(payload).toMatchObject({ cuit: Number(company.cuit), ptoVta: 22, tipoCmp: 11, nroCmp: result.cbteNro, importe: 1000, codAut: Number(result.cae) });
    const pdf = await renderInvoicePdf(model);
    expect(Buffer.from(pdf).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("serializes simultaneous manual and reviewed issuance with consecutive numbers", async () => {
    const { invoice, company, deps } = await fixture(23);
    const input = await reviewEmissionInput(deps, invoice.id);
    const [reviewed, manual] = await Promise.all([
      emitReviewedInvoice(deps, invoice.id),
      emitComprobante(deps, { ...input, idempotencyKey: "manual-concurrent" }),
    ]);
    expect([reviewed.cbteNro, manual.cbteNro].sort()).toEqual([1, 2]);
    expect(reviewed.id).not.toBe(manual.id);
    expect((await handle.db.select().from(comprobantes)).filter(r => r.empresaId === company.id && r.ptoVta === 23)).toHaveLength(2);
    expect(await handle.db.select().from(issuedInvoices)).toHaveLength(0);
  });
});
