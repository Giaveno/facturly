import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test-support/test-db";
import {
  batches,
  clients,
  invoices,
  ocrRows,
  photos,
} from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { listReviewInvoices } from "./read-model";

describe("listReviewInvoices — materializes invoices for the review page", () => {
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
    await db.delete(invoices);
    await db.delete(ocrRows);
    await db.delete(photos);
    await db.delete(batches);
  });

  afterAll(async () => {
    await close();
  });

  async function seedRow(
    status: "CONFIDENT" | "BLOCKED" | "CORRECTED",
    cuit: string | null,
  ) {
    const [batch] = await db.insert(batches).values({ clientId }).returning();
    const [photo] = await db.insert(photos).values({ batchId: batch!.id, storageKey: "k.jpg" }).returning();
    const [row] = await db
      .insert(ocrRows)
      .values({
        photoId: photo!.id,
        fields: { name: "PAGADOR S.A.", amount: 100000, date: "2026-09-22" },
        confidence: { name: 0.9, amount: 0.9 },
        cuit,
        status,
      })
      .returning();
    return row!.id;
  }

  it("materializes an invoice per row and exposes invoiceId + invoiceStatus", async () => {
    const rowId = await seedRow("CONFIDENT", "30710145764");
    const rows = await listReviewInvoices(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rowId).toBe(rowId);
    expect(rows[0]!.invoiceId).toBeDefined();
    expect(rows[0]!.invoiceStatus).toBe("PENDING"); // CONFIDENT → PENDING
  });

  it("flags a row with no valid CUIT (needs payer resolution)", async () => {
    await seedRow("CONFIDENT", null);
    const rows = await listReviewInvoices(db);
    expect(rows[0]!.flagged).toBe(true);
    expect(rows[0]!.blocked).toBe(false);
  });

  it("does NOT flag a row with a valid CUIT", async () => {
    await seedRow("CONFIDENT", "30710145764");
    const rows = await listReviewInvoices(db);
    expect(rows[0]!.flagged).toBe(false);
  });

  it("a BLOCKED row keeps its invoice PENDING and blocked=true", async () => {
    await seedRow("BLOCKED", "30710145764");
    const rows = await listReviewInvoices(db);
    expect(rows[0]!.blocked).toBe(true);
    expect(rows[0]!.invoiceStatus).toBe("PENDING");
  });

  it("a CORRECTED row materializes a REVIEWED invoice (approvable)", async () => {
    await seedRow("CORRECTED", "30710145764");
    const rows = await listReviewInvoices(db);
    expect(rows[0]!.invoiceStatus).toBe("REVIEWED");
  });

  it("surfaces a registry-resolved CUIT as not-flagged with its source", async () => {
    const [batch] = await db.insert(batches).values({ clientId }).returning();
    const [photo] = await db
      .insert(photos)
      .values({ batchId: batch!.id, storageKey: "k.jpg" })
      .returning();
    await db.insert(ocrRows).values({
      photoId: photo!.id,
      fields: { name: "PAGADOR S.A.", amount: 100000, date: "2026-09-22" },
      confidence: { name: 0.9, amount: 0.9 },
      cuit: "30710145764",
      cuitSource: "registry",
      status: "CONFIDENT",
    });

    const rows = await listReviewInvoices(db);
    expect(rows[0]!.cuitSource).toBe("registry");
    expect(rows[0]!.flagged).toBe(false);
    expect(rows[0]!.blocked).toBe(false);
  });

  it("re-syncs an existing invoice when the row transitions to CORRECTED", async () => {
    const rowId = await seedRow("BLOCKED", "30710145764");
    await listReviewInvoices(db); // materializes a PENDING invoice
    await db.update(ocrRows).set({ status: "CORRECTED" }).where(eq(ocrRows.id, rowId));

    const rows = await listReviewInvoices(db);
    expect(rows[0]!.invoiceStatus).toBe("REVIEWED");
    // No duplicate invoice was created.
    const all = await db.select().from(invoices);
    expect(all).toHaveLength(1);
  });

  it("a second listing does NOT change any invoice status (idempotent re-read)", async () => {
    const rowId = await seedRow("CONFIDENT", "30710145764");
    await listReviewInvoices(db); // materializes a PENDING invoice
    const [before] = await db.select().from(invoices).where(eq(invoices.ocrRowId, rowId));

    await listReviewInvoices(db); // second listing

    const [after] = await db.select().from(invoices).where(eq(invoices.ocrRowId, rowId));
    expect(after!.status).toBe(before!.status);
  });

  it("listing after an invoice is EMITTED leaves it EMITTED (no regression, C2)", async () => {
    const rowId = await seedRow("CORRECTED", "30710145764");
    await listReviewInvoices(db); // materializes REVIEWED
    await db.update(invoices).set({ status: "EMITTED" }).where(eq(invoices.ocrRowId, rowId));

    const rows = await listReviewInvoices(db); // MUST NOT rewind EMITTED → REVIEWED
    expect(rows[0]!.invoiceStatus).toBe("EMITTED");
    const [inv] = await db.select().from(invoices).where(eq(invoices.ocrRowId, rowId));
    expect(inv!.status).toBe("EMITTED");
  });
});
