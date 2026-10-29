import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test-support/test-db";
import { batches, clients, photos, ocrRows } from "@/lib/db/schema";
import { processUpload, queueUpload } from "./ingest";
import { listReviewRows } from "@/lib/review/read-model";
import { markRowCorrected } from "@/lib/review/correct";
import {
  assertRowEmittable,
  isRowEmittable,
  invoiceStatusForRow,
  RowNotEmittableError,
} from "@/domain/emission";
import { OcrFake } from "@/adapters/ocr/ocr.fake";
import { isValidCuit } from "@/domain/cuit";
import type { Db } from "@/lib/db/types";
import type { OcrProvider } from "@/ports/ocr-provider";

const confident = new Uint8Array([0x00]);
const lowConfidence = new Uint8Array([0x01]);
const noCuit = new Uint8Array([0x42]);

/** OCR adapter that fails on its second call — used to prove rollback. */
class FailOnSecondOcr implements OcrProvider {
  private calls = 0;
  private fake = new OcrFake();

  async extract(image: Uint8Array) {
    this.calls += 1;
    if (this.calls === 2) throw new Error("mid-batch OCR failure");
    return this.fake.extract(image);
  }
}

describe("offline pipeline: upload → OCR → row persists", () => {
  let db: Db;
  let close: () => Promise<void>;
  let clientAId: string;
  let clientBId: string;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    const [a] = await db
      .insert(clients)
      .values({
        cuit: "20123456786",
        razonSocial: "CLIENTE A S.A.",
        ptoVta: 1,
        condicionIva: "ri",
      })
      .returning();
    const [b] = await db
      .insert(clients)
      .values({
        cuit: "30710145764",
        razonSocial: "CLIENTE B S.R.L.",
        ptoVta: 2,
        condicionIva: "monotributista",
      })
      .returning();
    clientAId = a!.id;
    clientBId = b!.id;
  });

  // One migrated DB shared by the file; each test resets the ingest tables so
  // assertions can never pass on stale rows from an earlier test.
  beforeEach(async () => {
    await db.delete(ocrRows);
    await db.delete(photos);
    await db.delete(batches);
  });

  afterAll(async () => {
    await close();
  });

  it("groups photos under the given client — no auto-attribution", async () => {
    const result = await processUpload(
      clientAId,
      [
        { storageKey: "a-1.jpg", image: confident },
        { storageKey: "a-2.jpg", image: confident },
      ],
      { db, ocr: new OcrFake() },
    );

    expect(result.clientId).toBe(clientAId);
    expect(result.rows).toHaveLength(2);

    const [batch] = await db
      .select()
      .from(batches)
      .where(eq(batches.id, result.batchId));
    expect(batch!.clientId).toBe(clientAId);

    const batchPhotos = await db
      .select()
      .from(photos)
      .where(eq(photos.batchId, result.batchId));
    expect(batchPhotos).toHaveLength(2);
    for (const p of batchPhotos) {
      expect(p.batchId).toBe(result.batchId);
    }
  });

  it("persists a confident row as CONFIDENT with a checksum-valid CUIT", async () => {
    const result = await processUpload(
      clientAId,
      [{ storageKey: "confident.jpg", image: confident }],
      { db, ocr: new OcrFake() },
    );
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;
    expect(row.status).toBe("CONFIDENT");
    expect(row.cuit).toBeDefined();
    expect(isValidCuit(row.cuit!)).toBe(true);
  });

  it("persists a row with NO CUIT (registry resolution deferred)", async () => {
    const result = await processUpload(
      clientAId,
      [{ storageKey: "no-cuit.jpg", image: noCuit }],
      { db, ocr: new OcrFake() },
    );
    const row = result.rows[0]!;
    expect(row.status).toBe("CONFIDENT"); // legible fields, just no CUIT
    expect(row.cuit).toBeNull();
  });

  it("persists a low-confidence row as BLOCKED", async () => {
    const result = await processUpload(
      clientAId,
      [{ storageKey: "blocked.jpg", image: lowConfidence }],
      { db, ocr: new OcrFake() },
    );
    const row = result.rows[0]!;
    expect(row.status).toBe("BLOCKED");
    expect(row.cuit).toBeNull();
  });

  it("read model marks BLOCKED rows blocked AND the guard agrees they cannot emit", async () => {
    await processUpload(
      clientAId,
      [
        { storageKey: "ok.jpg", image: confident },
        { storageKey: "bad.jpg", image: lowConfidence },
      ],
      { db, ocr: new OcrFake() },
    );
    const rows = await listReviewRows(db);
    expect(rows).toHaveLength(2);

    const ok = rows.find((r) => r.status === "CONFIDENT");
    const bad = rows.find((r) => r.status === "BLOCKED");
    expect(ok).toBeDefined();
    expect(bad).toBeDefined();

    // The UI flag must agree with the real enforcement guard.
    expect(ok!.blocked).toBe(false);
    expect(bad!.blocked).toBe(true);
    expect(isRowEmittable(bad!.status)).toBe(false);
    expect(() => assertRowEmittable(bad!.status)).toThrow(RowNotEmittableError);
  });

  it("read model surfaces a FAILED row (failed + error) — W7", async () => {
    const [batch] = await db
      .insert(batches)
      .values({ clientId: clientAId })
      .returning();
    const [photo] = await db
      .insert(photos)
      .values({ batchId: batch!.id, storageKey: "crash.jpg" })
      .returning();
    await db.insert(ocrRows).values({
      photoId: photo!.id,
      fields: { name: "", amount: 0, date: "" },
      confidence: {},
      cuit: null,
      status: "FAILED",
      error: "multimodal OCR crashed",
    });

    const rows = await listReviewRows(db);
    const failed = rows.find((r) => r.status === "FAILED");
    expect(failed).toBeDefined();
    expect(failed!.failed).toBe(true);
    expect(failed!.error).toContain("crashed");
    // A FAILED row is never emittable.
    expect(isRowEmittable("FAILED")).toBe(false);
  });

  it("a BLOCKED row cannot emit; a CORRECTED row becomes eligible for explicit review", async () => {
    const result = await processUpload(
      clientAId,
      [{ storageKey: "blocked.jpg", image: lowConfidence }],
      { db, ocr: new OcrFake() },
    );
    const blocked = result.rows[0]!;
    expect(blocked.status).toBe("BLOCKED");

    // BLOCKED ⇒ not emittable, invoice stays PENDING.
    expect(isRowEmittable(blocked.status)).toBe(false);
    expect(() => assertRowEmittable(blocked.status)).toThrow(RowNotEmittableError);
    expect(invoiceStatusForRow("BLOCKED")).toBe("PENDING");

    // The human corrects the row (the CORRECTED transition).
    const corrected = await markRowCorrected(db, blocked.id);
    expect(corrected.status).toBe("CORRECTED");

    // CORRECTED ⇒ emittable, invoice becomes REVIEWED.
    expect(isRowEmittable(corrected.status)).toBe(true);
    expect(() => assertRowEmittable(corrected.status)).not.toThrow();
    expect(invoiceStatusForRow("CORRECTED")).toBe("PENDING");
  });

  it("keeps batches isolated across clients", async () => {
    const resultA = await processUpload(
      clientAId,
      [{ storageKey: "a.jpg", image: confident }],
      { db, ocr: new OcrFake() },
    );
    const resultB = await processUpload(
      clientBId,
      [{ storageKey: "b.jpg", image: confident }],
      { db, ocr: new OcrFake() },
    );

    const [batchA] = await db
      .select()
      .from(batches)
      .where(eq(batches.id, resultA.batchId));
    const [batchB] = await db
      .select()
      .from(batches)
      .where(eq(batches.id, resultB.batchId));
    expect(batchA!.clientId).toBe(clientAId);
    expect(batchB!.clientId).toBe(clientBId);
    expect(batchA!.clientId).not.toBe(batchB!.clientId);
  });

  it("queueUpload persists PENDING rows without running OCR (async path)", async () => {
    const result = await queueUpload(
      clientAId,
      [
        { storageKey: "a.jpg", image: confident },
        { storageKey: "b.jpg", image: lowConfidence },
      ],
      { db },
    );

    expect(result.rows).toHaveLength(2);
    // Every row is born PENDING — no inline OCR, no extracted fields yet.
    expect(result.rows.every((r) => r.status === "PENDING")).toBe(true);
    expect(result.rows.every((r) => r.cuit === null)).toBe(true);

    const rows = await db.select().from(ocrRows);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "PENDING")).toBe(true);
    expect(rows.every((r) => r.fields.amount === 0)).toBe(true);
    expect(rows.every((r) => Object.keys(r.confidence).length === 0)).toBe(true);
  });

  it("rolls back the whole batch when OCR fails mid-loop (no partial rows)", async () => {
    await expect(
      processUpload(
        clientAId,
        [
          { storageKey: "1.jpg", image: confident },
          { storageKey: "2.jpg", image: confident },
          { storageKey: "3.jpg", image: confident },
        ],
        { db, ocr: new FailOnSecondOcr() },
      ),
    ).rejects.toThrow("mid-batch OCR failure");

    expect((await db.select().from(batches)).length).toBe(0);
    expect((await db.select().from(photos)).length).toBe(0);
    expect((await db.select().from(ocrRows)).length).toBe(0);
  });
});
