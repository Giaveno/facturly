import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test-support/test-db";
import {
  auditLog,
  batches,
  clients,
  invoices,
  ocrRows,
  payers,
  photos,
} from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { materializeInvoice } from "./workflow";
import {
  PayerCuitInvalidError,
  RowNotFoundError,
  RowNotResolvableError,
  resolvePayerCuit,
} from "./resolve-payer";

describe("resolvePayerCuit — unblocks flagged rows", () => {
  let db: Db;
  let close: () => Promise<void>;
  let clientId: string;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    const [client] = await db
      .insert(clients)
      .values({ cuit: "20123456786", razonSocial: "EMISOR S.A.", ptoVta: 1, condicionIva: "ri" })
      .returning();
    clientId = client!.id;
  });

  beforeEach(async () => {
    await db.delete(auditLog);
    await db.delete(invoices);
    await db.delete(ocrRows);
    await db.delete(photos);
    await db.delete(batches);
    await db.delete(payers);
  });

  afterAll(async () => {
    await close();
  });

  async function seedRow(
    status: "CONFIDENT" | "BLOCKED" | "FAILED",
    cuit: string | null,
  ) {
    const [batch] = await db.insert(batches).values({ clientId }).returning();
    const [photo] = await db.insert(photos).values({ batchId: batch!.id, storageKey: "k.jpg" }).returning();
    const [row] = await db
      .insert(ocrRows)
      .values({
        photoId: photo!.id,
        fields: { name: "PAGOS DELTA SRL", cbu: "0110599520000001111111", amount: 100000, date: "2026-09-22" },
        confidence: { name: 0.9, amount: 0.9 },
        cuit,
        status,
      })
      .returning();
    return row!.id;
  }

  it("rejects an invalid CUIT before touching the DB", async () => {
    const rowId = await seedRow("CONFIDENT", null);
    await expect(resolvePayerCuit(db, rowId, "123")).rejects.toThrow(PayerCuitInvalidError);
    const [row] = await db.select().from(ocrRows).where(eq(ocrRows.id, rowId));
    expect(row!.cuit).toBeNull();
  });

  it("throws RowNotFoundError for a missing row", async () => {
    await expect(
      resolvePayerCuit(db, "00000000-0000-4000-8000-000000000000", "30710145764"),
    ).rejects.toThrow(RowNotFoundError);
  });

  it("learns a new payer, sets the CUIT, marks CORRECTED → REVIEWED, and audits", async () => {
    const rowId = await seedRow("CONFIDENT", null);
    const result = await resolvePayerCuit(db, rowId, "30710145764");

    expect(result.status).toBe("CORRECTED");
    expect(result.invoiceStatus).toBe("PENDING");
    expect(result.inserted).toBe(true);
    expect(result.learnedFrom).toBe("manual");

    // The row now carries the CUIT.
    const [row] = await db.select().from(ocrRows).where(eq(ocrRows.id, rowId));
    expect(row!.cuit).toBe("30710145764");
    expect(row!.status).toBe("CORRECTED");
    expect(row!.cuitSource).toBe("manual");

    // The registry learned the payer with learnedFrom='manual'.
    const payerRows = await db.select().from(payers);
    expect(payerRows).toHaveLength(1);
    expect(payerRows[0]!.cuit).toBe("30710145764");
    expect(payerRows[0]!.learnedFrom).toBe("manual");

    // An audit entry records the resolution.
    const audits = await db.select().from(auditLog).where(eq(auditLog.rowId, rowId));
    expect(audits.some((a) => a.action === "payer.cuit_resolved")).toBe(true);
  });

  it("matches an existing payer by CBU and updates the registry (learn, no insert)", async () => {
    // A payer already exists with this CBU but no CUIT yet.
    await db.insert(payers).values({ name: "PAGOS DELTA", cbu: "0110599520000001111111", learnedFrom: "manual" });

    const rowId = await seedRow("BLOCKED", null);
    const result = await resolvePayerCuit(db, rowId, "30710145764");

    expect(result.inserted).toBe(false);
    const payerRows = await db.select().from(payers);
    expect(payerRows).toHaveLength(1);
    expect(payerRows[0]!.cuit).toBe("30710145764");
  });

  it("makes a BLOCKED row approvable (CORRECTED ⇒ REVIEWED invoice)", async () => {
    const rowId = await seedRow("BLOCKED", null);
    const result = await resolvePayerCuit(db, rowId, "30710145764");

    // The invoice was materialized (or re-synced) to REVIEWED — approvable.
    const [invoice] = await db.select().from(invoices).where(eq(invoices.ocrRowId, rowId));
    expect(invoice!.status).toBe("PENDING");
    expect(result.invoiceId).toBe(invoice!.id);
  });

  it("refuses a FAILED row — a crashed extraction is never emittable via CUIT resolution (C1)", async () => {
    const rowId = await seedRow("FAILED", null);
    await expect(resolvePayerCuit(db, rowId, "30710145764")).rejects.toThrow(
      RowNotResolvableError,
    );
    // The FAILED status is sticky: the row is NOT flipped to CORRECTED.
    const [row] = await db.select().from(ocrRows).where(eq(ocrRows.id, rowId));
    expect(row!.status).toBe("FAILED");
    expect(row!.cuit).toBeNull();
  });

  it("refuses a row whose invoice is REJECTED (C1)", async () => {
    const rowId = await seedRow("BLOCKED", "30710145764");
    await materializeInvoice(db, rowId);
    await db
      .update(invoices)
      .set({ status: "REJECTED", discardReason: "non-sale" })
      .where(eq(invoices.ocrRowId, rowId));

    await expect(resolvePayerCuit(db, rowId, "30710145764")).rejects.toThrow(
      RowNotResolvableError,
    );
  });

  it("refuses a row whose invoice is EMITTED (C1)", async () => {
    const rowId = await seedRow("CONFIDENT", "30710145764");
    await materializeInvoice(db, rowId);
    await db
      .update(invoices)
      .set({ status: "EMITTED" })
      .where(eq(invoices.ocrRowId, rowId));

    await expect(resolvePayerCuit(db, rowId, "30710145764")).rejects.toThrow(
      RowNotResolvableError,
    );
  });
});
