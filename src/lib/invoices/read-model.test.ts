import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestDb } from "@/test-support/test-db";
import {
  auditLog,
  batches,
  clients,
  invoices,
  issuedInvoices,
  ocrRows,
  photos,
} from "@/lib/db/schema";
import { listIssuedInvoices, loadIssuedInvoicePdfInput } from "./read-model";
import type { Db } from "@/lib/db/types";

/**
 * Invoices read-model — the queries behind the Invoices page and the PDF
 * download route. The critical guarantee tested here: a NULL-CAE reservation is
 * NOT a downloadable issued invoice (loadIssuedInvoicePdfInput returns null) AND
 * is EXCLUDED from the issued-invoices list (listIssuedInvoices filters on
 * `cae IS NOT NULL`). An unissued invoice is not an issued invoice.
 */
describe("invoices read-model", () => {
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
  });

  afterAll(async () => {
    await close();
  });

  async function seedIssued({
    cae,
    cbteNro = 1,
  }: {
    cae: string | null;
    cbteNro?: number;
  }) {
    const [batch] = await db.insert(batches).values({ clientId }).returning();
    const [photo] = await db
      .insert(photos)
      .values({ batchId: batch!.id, storageKey: "k.jpg" })
      .returning();
    const [row] = await db
      .insert(ocrRows)
      .values({
        photoId: photo!.id,
        fields: { name: "ACME S.A.", amount: 121000, date: "2026-09-22" },
        confidence: { name: 0.9 },
        status: "CONFIDENT",
      })
      .returning();
    const [inv] = await db
      .insert(invoices)
      .values({
        ocrRowId: row!.id,
        clientId,
        status: "EMITTED",
        cbteTipo: 1,
        receptorDocTipo: 80,
        receptorDocNro: 20123456786,
        condicionIvaReceptorId: 6,
        receptorRazonSocial: "ACME S.A.",
        fechaEmision: "2026-09-22",
        fechaVto: "2026-09-22",
        moneda: "PES",
        cotizacion: 1,
        importeNetoCentavos: 100000,
        importeIvaCentavos: 21000,
        importeTotalCentavos: 121000,
      })
      .returning();
    await db.insert(issuedInvoices).values({
      invoiceId: inv!.id,
      cuit: "20123456789",
      ptoVta: 1,
      cbteTipo: 1,
      cbteNro,
      cae,
      caeFchVto: cae ? "2026-10-02" : null,
      importeTotalCentavos: 121000,
    });
    return inv!.id;
  }

  it("lists an emitted invoice with status, client, type, number, CAE, amount", async () => {
    await seedIssued({ cae: "70000000000001" });

    const rows = await listIssuedInvoices(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "EMITTED",
      razonSocial: "EMISOR S.A.",
      cbteTipo: 1,
      cbteNro: 1,
      cae: "70000000000001",
      importeTotalCentavos: 121000,
    });
  });

  it("loadIssuedInvoicePdfInput returns the full PDF input for an emitted invoice", async () => {
    const invoiceId = await seedIssued({ cae: "70000000000001" });

    const input = await loadIssuedInvoicePdfInput(db, invoiceId);
    expect(input).not.toBeNull();
    expect(input!.cae).toBe("70000000000001");
    expect(input!.cuit).toBe("20123456789");
    expect(input!.cbteTipo).toBe(1);
    expect(input!.cbteNro).toBe(1);
    expect(input!.receptorRazonSocial).toBe("ACME S.A.");
    expect(input!.importeTotal).toBe(121000);
  });

  it("excludes a NULL-CAE reservation from the issued list (and still refuses the PDF)", async () => {
    const invoiceId = await seedIssued({ cae: null });

    // A reservation (emission in flight / EMIT_ERROR) is NOT an issued invoice:
    // it MUST NOT appear in the issued-invoices list.
    const rows = await listIssuedInvoices(db);
    expect(rows).toHaveLength(0);
    // …and the PDF route MUST still refuse it.
    await expect(loadIssuedInvoicePdfInput(db, invoiceId)).resolves.toBeNull();
  });

  it("lists an emitted invoice and excludes a NULL-CAE reservation alongside it", async () => {
    await seedIssued({ cae: "70000000000002", cbteNro: 2 });
    await seedIssued({ cae: null, cbteNro: 3 });

    const rows = await listIssuedInvoices(db);
    // Only the genuinely-issued invoice (with a CAE) is listed.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cae).toBe("70000000000002");
  });

  it("returns null for an unknown invoice id", async () => {
    await expect(
      loadIssuedInvoicePdfInput(db, "00000000-0000-4000-8000-000000000000"),
    ).resolves.toBeNull();
  });
});
