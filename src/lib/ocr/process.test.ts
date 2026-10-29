import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test-support/test-db";
import {
  auditLog,
  batches,
  clients,
  issuedInvoices,
  invoices,
  ocrRows,
  payers,
  photos,
} from "@/lib/db/schema";
import { OcrFake } from "@/adapters/ocr/ocr.fake";
import { isValidCuit } from "@/domain/cuit";
import { processOcrRow } from "./process";
import type { OcrProvider } from "@/ports/ocr-provider";
import type { Db } from "@/lib/db/types";

describe("async OCR — moves OCR off the request path (PENDING → CONFIDENT/BLOCKED)", () => {
  let db: Db;
  let close: () => Promise<void>;
  let clientId: string;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    const [client] = await db
      .insert(clients)
      .values({
        cuit: "20123456789",
        razonSocial: "EMISOR S.A.",
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
    await db.delete(ocrRows);
    await db.delete(photos);
    await db.delete(batches);
    await db.delete(payers);
  });

  afterAll(async () => {
    await close();
  });

  async function seedPendingRow() {
    const [batch] = await db
      .insert(batches)
      .values({ clientId })
      .returning();
    const [photo] = await db
      .insert(photos)
      .values({ batchId: batch!.id, storageKey: "receipt.jpg" })
      .returning();
    const [row] = await db
      .insert(ocrRows)
      .values({
        photoId: photo!.id,
        fields: { name: "", amount: 0, date: "" },
        confidence: {},
        cuit: null,
        status: "PENDING",
      })
      .returning();
    return row!.id;
  }

  const readerFor = (image: Uint8Array) => async (key: string) => {
    expect(key).toBe("receipt.jpg");
    return image;
  };

  it("promotes a PENDING row to CONFIDENT with a checksum-valid CUIT", async () => {
    const rowId = await seedPendingRow();
    const result = await processOcrRow(
      db,
      new OcrFake(),
      rowId,
      readerFor(new Uint8Array([0x00])), // confident
    );
    expect(result.status).toBe("CONFIDENT");

    const [row] = await db.select().from(ocrRows).where(eq(ocrRows.id, rowId));
    expect(row!.status).toBe("CONFIDENT");
    expect(row!.fields.name).toBe("ACME S.A.");
    expect(isValidCuit(row!.cuit!)).toBe(true);
  });

  it("promotes a PENDING row to BLOCKED on low confidence", async () => {
    const rowId = await seedPendingRow();
    const result = await processOcrRow(
      db,
      new OcrFake(),
      rowId,
      readerFor(new Uint8Array([0x01])), // lowConfidence
    );
    expect(result.status).toBe("BLOCKED");
    const [row] = await db.select().from(ocrRows).where(eq(ocrRows.id, rowId));
    expect(row!.status).toBe("BLOCKED");
    expect(row!.cuit).toBeNull();
  });

  it("is idempotent: an already-processed row is a no-op (image never re-read)", async () => {
    const rowId = await seedPendingRow();
    await processOcrRow(db, new OcrFake(), rowId, readerFor(new Uint8Array([0x00])));

    let readCalls = 0;
    const result = await processOcrRow(db, new OcrFake(), rowId, async () => {
      readCalls += 1;
      throw new Error("should not read");
    });
    expect(result.status).toBe("CONFIDENT");
    expect(readCalls).toBe(0);
  });

  it("W7: a crashed extraction marks the row FAILED (never stuck PENDING)", async () => {
    const rowId = await seedPendingRow();
    const crashing: OcrProvider = {
      extract: async () => {
        throw new Error("multimodal OCR crashed");
      },
    };

    const result = await processOcrRow(
      db,
      crashing,
      rowId,
      readerFor(new Uint8Array([0x00])),
    );
    expect(result.status).toBe("FAILED");

    const [row] = await db.select().from(ocrRows).where(eq(ocrRows.id, rowId));
    expect(row!.status).toBe("FAILED");
    expect(row!.error).toContain("crashed");
  });

  it("resolves registry evidence only for an explicitly identified legacy pending row", async () => {
    // The registry already knows PAGOS DELTA by CVU (from a past correction).
    await db.insert(payers).values({
      name: "PAGOS DELTA",
      cvu: "0000003100000000000001",
      cuit: "20123456786",
      learnedFrom: "manual",
    });

    const rowId = await seedPendingRow();
    await db.update(ocrRows).set({recipientMode:"identified",recipientModeSource:"legacy_migration"}).where(eq(ocrRows.id,rowId));
    const result = await processOcrRow(
      db,
      new OcrFake(),
      rowId,
      readerFor(new Uint8Array([0x42])), // noCuit scenario (CVU + alias, no CUIT)
    );
    expect(result.status).toBe("CONFIDENT");

    const [row] = await db.select().from(ocrRows).where(eq(ocrRows.id, rowId));
    expect(row!.cuit).toBe("20123456786");
    expect(row!.cuitSource).toBe("registry");

    // An audit entry records the registry resolution with the matched key.
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.rowId, rowId));
    const entry = audits.find((a) => a.action === "payer.cuit_registry_resolved");
    expect(entry).toBeDefined();
    expect(entry!.payload).toEqual({ matchedBy: "cvu" });
  });

  it("never overrides a valid OCR CUIT with a registry CUIT", async () => {
    // A payer with the confident receipt's CBU holds a DIFFERENT CUIT — the OCR
    // extraction must win.
    await db.insert(payers).values({
      name: "ACME",
      cbu: "0110599520000001234567",
      cuit: "30710145764",
      learnedFrom: "manual",
    });

    const rowId = await seedPendingRow();
    await processOcrRow(db, new OcrFake(), rowId, readerFor(new Uint8Array([0x00])));

    const [row] = await db.select().from(ocrRows).where(eq(ocrRows.id, rowId));
    expect(row!.cuit).toBe("23000000809"); // the OCR's own CUIT, not the registry's
    expect(row!.cuitSource).toBe("ocr");
  });
});
