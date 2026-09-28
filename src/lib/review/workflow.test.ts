import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test-support/test-db";
import {
  auditLog,
  batches,
  clients,
  invoices,
  issuedInvoices,
  ocrRows,
  payers,
  photos,
  delegations,
} from "@/lib/db/schema";
import { ArcaGatewayFake } from "@/adapters/arca/arca-gateway.fake";
import {
  approveInvoice,
  InvoiceStateError,
  loadInvoiceContext,
  markInvoiceReviewed,
  materializeInvoice,
  rejectInvoice,
} from "./workflow";
import type { Db } from "@/lib/db/types";

const FIXED_DATE = new Date("2026-09-22T00:00:00.000Z");

describe("review workflow — invoice status machine (server-side)", () => {
  let db: Db;
  let close: () => Promise<void>;
  let gateway: ArcaGatewayFake;
  let clientRiId: string;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    gateway = new ArcaGatewayFake(undefined, () => FIXED_DATE);
    const [client] = await db
      .insert(clients)
      .values({
        cuit: "20123456789",
        razonSocial: "EMISOR RI S.A.",
        ptoVta: 1,
        condicionIva: "ri",
      })
      .returning();
    clientRiId = client!.id;
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

  async function seedRow(
    status: "PENDING" | "CONFIDENT" | "BLOCKED" | "CORRECTED",
    cuit: string | null,
  ) {
    const [batch] = await db
      .insert(batches)
      .values({ clientId: clientRiId })
      .returning();
    const [photo] = await db
      .insert(photos)
      .values({ batchId: batch!.id, storageKey: "k.jpg" })
      .returning();
    const [row] = await db
      .insert(ocrRows)
      .values({
        photoId: photo!.id,
        fields: { name: "PAGADOR S.A.", amount: 121000, date: "2026-09-22" },
        confidence: { name: 0.9, amount: 0.9 },
        cuit,
        status,
      })
      .returning();
    return row!.id;
  }

  it("materializes a CONFIDENT row as PENDING (awaiting review)", async () => {
    const rowId = await seedRow("CONFIDENT", "30710145764");
    const inv = await materializeInvoice(db, rowId);
    expect(inv.status).toBe("PENDING");
    const ctx = await loadInvoiceContext(db, inv.id);
    expect(ctx.invoice.importeTotalCentavos).toBe(121000);
  });

  it("materializes a BLOCKED row as PENDING; a corrected row becomes REVIEWED", async () => {
    const rowId = await seedRow("BLOCKED", "30710145764");
    const inv = await materializeInvoice(db, rowId);
    expect(inv.status).toBe("PENDING");

    // The human corrects the row, then the invoice re-syncs to REVIEWED.
    await db.update(ocrRows).set({ status: "CORRECTED" }).where(eq(ocrRows.id, rowId));
    const resynced = await materializeInvoice(db, rowId);
    expect(resynced.status).toBe("REVIEWED");
  });

  it("markInvoiceReviewed: PENDING → REVIEWED, and refuses a non-PENDING invoice", async () => {
    const rowId = await seedRow("CONFIDENT", "30710145764");
    const inv = await materializeInvoice(db, rowId);
    const reviewed = await markInvoiceReviewed(db, inv.id);
    expect(reviewed.status).toBe("REVIEWED");
    await expect(markInvoiceReviewed(db, inv.id)).rejects.toThrow(InvoiceStateError);
  });

  it("approveInvoice: RI → Monotributista resolves Factura A(1) + DocTipo 80 + condition id 6 + 21% IVA", async () => {
    const rowId = await seedRow("CORRECTED", "30710145764"); // monotributista payer
    const inv = await materializeInvoice(db, rowId);
    const approved = await approveInvoice(db, gateway, inv.id, () => FIXED_DATE);

    expect(approved.status).toBe("APPROVED");
    expect(approved.cbteTipo).toBe(1); // Factura A
    expect(approved.receptorDocTipo).toBe(80); // CUIT document type
    expect(approved.condicionIvaReceptorId).toBe(6); // monotributista (RG 5616)
    expect(approved.receptorDocNro).toBe(30710145764);
    expect(approved.importeNetoCentavos).toBe(100000);
    expect(approved.importeIvaCentavos).toBe(21000);
    expect(approved.importeTotalCentavos).toBe(121000);
    expect(approved.fechaEmision).toBe("2026-09-22");
    expect(approved.moneda).toBe("PES");

    // C5: approval is audited.
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.invoiceId, inv.id));
    expect(audits.some((a) => a.action === "invoice.approved")).toBe(true);
  });

  it("approveInvoice: RI → RI resolves Factura A(1) + DocTipo 80 + condition id 1", async () => {
    const rowId = await seedRow("CORRECTED", "20123456786"); // ri payer
    const inv = await materializeInvoice(db, rowId);
    const approved = await approveInvoice(db, gateway, inv.id, () => FIXED_DATE);
    expect(approved.cbteTipo).toBe(1);
    expect(approved.receptorDocTipo).toBe(80); // CUIT document type
    expect(approved.condicionIvaReceptorId).toBe(1); // ri (RG 5616)
  });

  it("approveInvoice: no payer CUIT → flags for review (never silently Consumidor Final)", async () => {
    const rowId = await seedRow("CORRECTED", null);
    const inv = await materializeInvoice(db, rowId);
    await expect(
      approveInvoice(db, gateway, inv.id, () => FIXED_DATE),
    ).rejects.toThrow(/payer CUIT is missing or invalid/);
    // Not approved — still REVIEWED.
    const ctx = await loadInvoiceContext(db, inv.id);
    expect(ctx.invoice.status).toBe("REVIEWED");
    // W1: flagged for review in the audit trail (not a silent Factura B).
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.invoiceId, inv.id));
    expect(audits.some((a) => a.action === "invoice.flagged_review")).toBe(true);
  });

  it("approveInvoice refuses a PENDING (not yet reviewed) invoice", async () => {
    const rowId = await seedRow("CONFIDENT", "30710145764");
    const inv = await materializeInvoice(db, rowId); // PENDING
    await expect(
      approveInvoice(db, gateway, inv.id, () => FIXED_DATE),
    ).rejects.toThrow(InvoiceStateError);
  });

  it("approveInvoice fails loudly on an unresolved payer condition (never CF)", async () => {
    const rowId = await seedRow("CORRECTED", "20345678906"); // valid CUIT, absent from Padrón A5
    const inv = await materializeInvoice(db, rowId);
    await expect(
      approveInvoice(db, gateway, inv.id, () => FIXED_DATE),
    ).rejects.toThrow(/no Padrón A5 condition/);
    // The invoice must NOT have been approved.
    const ctx = await loadInvoiceContext(db, inv.id);
    expect(ctx.invoice.status).toBe("REVIEWED");
  });

  it("rejectInvoice discards with a reason and soft-retains the row", async () => {
    const rowId = await seedRow("CONFIDENT", "30710145764");
    const inv = await materializeInvoice(db, rowId);
    const rejected = await rejectInvoice(db, inv.id, "non-sale transfer");
    expect(rejected.status).toBe("REJECTED");
    expect(rejected.discardReason).toBe("non-sale transfer");

    // Soft-retained: the OCR row still exists.
    const [row] = await db.select().from(ocrRows).where(eq(ocrRows.id, rowId));
    expect(row).toBeDefined();

    // C5: rejection is audited.
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.invoiceId, inv.id));
    expect(audits.some((a) => a.action === "invoice.rejected")).toBe(true);
  });

  it("rejectInvoice requires a non-empty reason", async () => {
    const rowId = await seedRow("CONFIDENT", "30710145764");
    const inv = await materializeInvoice(db, rowId);
    await expect(rejectInvoice(db, inv.id, "   ")).rejects.toThrow(InvoiceStateError);
  });

  it("rejectInvoice refuses an already-approved invoice", async () => {
    const rowId = await seedRow("CORRECTED", "30710145764");
    const inv = await materializeInvoice(db, rowId);
    await approveInvoice(db, gateway, inv.id, () => FIXED_DATE);
    await expect(rejectInvoice(db, inv.id, "changed my mind")).rejects.toThrow(
      InvoiceStateError,
    );
  });
});
