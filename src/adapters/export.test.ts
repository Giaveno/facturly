import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as XLSX from "xlsx";
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
} from "@/lib/db/schema";
import { exportRowsToXlsx, listExportRows, type ExportRow } from "./export";
import type { Db } from "@/lib/db/types";

function readBack(xlsx: Uint8Array): Record<string, unknown>[] {
  const wb = XLSX.read(Buffer.from(xlsx), { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]!]!;
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);
}

describe("export — Excel fidelity (centavo-derived values, not floats)", () => {
  it("writes exactly the expected rows and fields", () => {
    const rows: ExportRow[] = [
      {
        razonSocial: "EMISOR S.A.",
        payerName: "ACME S.A.",
        cuit: "20123456786",
        amountCentavos: 121000,
        date: "2026-09-22",
        status: "EMITTED",
      },
      {
        razonSocial: "EMISOR S.A.",
        payerName: "PAGOS DELTA SRL",
        cuit: null,
        amountCentavos: 5500,
        date: "2026-09-21",
        status: "REVIEWED",
      },
    ];

    const out = readBack(exportRowsToXlsx(rows));
    expect(out).toHaveLength(2);

    expect(out[0]).toEqual({
      Client: "EMISOR S.A.",
      Payer: "ACME S.A.",
      CUIT: "20123456786",
      Amount: 1210, // numeric pesos (centavos / 100) — Excel can SUM it
      Date: "2026-09-22",
      Status: "EMITTED",
    });
    expect(out[1]).toEqual({
      Client: "EMISOR S.A.",
      Payer: "PAGOS DELTA SRL",
      CUIT: "",
      Amount: 55,
      Date: "2026-09-21",
      Status: "REVIEWED",
    });
  });

  it("writes amounts as NUMERIC cells (never float-drifted strings)", () => {
    const rows: ExportRow[] = [
      {
        razonSocial: "X",
        payerName: "Y",
        cuit: null,
        amountCentavos: 9999, // $99.99
        date: "2026-01-01",
        status: "REVIEWED",
      },
    ];
    const out = readBack(exportRowsToXlsx(rows));
    // Numeric cell, exact to the centavo — not a string, and not float-drifted.
    expect(typeof out[0]!.Amount).toBe("number");
    expect(out[0]!.Amount).toBe(99.99);
  });
});

describe("export — reviewed/emitted row selection", () => {
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

  async function seedInvoice(status: string) {
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
      .values({
        photoId: photo!.id,
        fields: { name: "PAGADOR", amount: 121000, date: "2026-09-22" },
        confidence: { name: 0.9 },
        status: "CONFIDENT",
      })
      .returning();
    await db.insert(invoices).values({
      ocrRowId: row!.id,
      clientId,
      status: status as never,
    });
  }

  it("exports only REVIEWED/APPROVED/EMITTED rows (not PENDING/REJECTED)", async () => {
    await seedInvoice("EMITTED");
    await seedInvoice("REVIEWED");
    await seedInvoice("PENDING");
    await seedInvoice("REJECTED");

    const rows = await listExportRows(db);
    expect(rows.map((r) => r.status).sort()).toEqual(["EMITTED", "REVIEWED"]);
    expect(rows).toHaveLength(2);
  });
});
