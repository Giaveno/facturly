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
  photos,
} from "@/lib/db/schema";
import { listIssuedInvoices, loadIssuedInvoicePdfInput } from "./read-model";
import type { Db } from "@/lib/db/types";
import { createInvoiceConsultation, loadReservedInvoice, listReservedAttempts } from "./reconciliation";
import { generateSelfSignedCert } from "@/test-support/pkcs7";
import { encryptPrivateKey, deriveAesKey } from "@/lib/db/credentials";
import { inspectCertificate } from "@/lib/credentials/pem";
import { WSAA_HOMOLOGACION_URL } from "@/adapters/arca/constants";

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
  it("pins PDF/QR issuer CUIT and PV to the issuance reservation, not mutable client settings",async()=>{
    const invoiceId=await seedIssued({cae:"70000000000001"});
    await db.update(clients).set({cuit:"20123456786",ptoVta:2}).where(eq(clients.id,clientId));
    try {expect(await loadIssuedInvoicePdfInput(db,invoiceId)).toMatchObject({cuit:"20123456789",ptoVta:1});}
    finally {await db.update(clients).set({cuit:"20123456789",ptoVta:1}).where(eq(clients.id,clientId));}
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

  it("keeps a closed no-record attempt as historical evidence, not an issued invoice", async () => {
    const invoiceId = await seedIssued({ cae: null });
    await db.update(invoices).set({ status: "EMIT_FAILED" }).where(eq(invoices.id, invoiceId));
    const [reservation] = await db.select().from(issuedInvoices).where(eq(issuedInvoices.invoiceId, invoiceId));
    const checkedAt = "2026-10-29T23:14:55.770Z";
    await db.insert(auditLog).values({ actor: "operator", action: "reservation_closed_no_record", invoiceId,
      payload: { reservationId: reservation!.id, cuit: reservation!.cuit, ptoVta: reservation!.ptoVta, cbteTipo: reservation!.cbteTipo, cbteNro: reservation!.cbteNro, code: "602", checkedAt } });
    expect(await listReservedAttempts(db)).toEqual([expect.objectContaining({ invoiceId, closedNoRecordAt: checkedAt, canConsult: false })]);
    expect(await listIssuedInvoices(db)).toEqual([]);
    expect(await loadIssuedInvoicePdfInput(db, invoiceId)).toBeNull();
  });

  it.each(["wrong-reservation", "invalid-date"])("ignores invalid historical closure: %s", async (invalid) => {
    const invoiceId = await seedIssued({ cae: null });
    const [reservation] = await db.select().from(issuedInvoices).where(eq(issuedInvoices.invoiceId, invoiceId));
    await db.insert(auditLog).values({ actor: "operator", action: "reservation_closed_no_record", invoiceId,
      payload: { reservationId: invalid === "wrong-reservation" ? "wrong" : reservation!.id, cuit: reservation!.cuit, ptoVta: reservation!.ptoVta,
        cbteTipo: reservation!.cbteTipo, cbteNro: reservation!.cbteNro, code: "602", checkedAt: invalid === "invalid-date" ? "invalid" : "2026-10-29T23:14:55.770Z" } });
    const [attempt] = await listReservedAttempts(db);
    expect(attempt).not.toHaveProperty("closedNoRecordAt");
  });

  it("lists real NULL-CAE attempts in every local state without treating legacy environment as safe", async () => {
    const invoiceId = await seedIssued({ cae: null });
    for (const status of ["EMIT_FAILED", "EMIT_ERROR", "EMITTING", "APPROVED"] as const) {
      await db.update(invoices).set({ status }).where(eq(invoices.id, invoiceId));
      expect(await listReservedAttempts(db)).toEqual([expect.objectContaining({ invoiceId, status, canConsult: false, cbteNro: 1 })]);
      expect(await listIssuedInvoices(db)).toEqual([]);
    }
  });

  it("consults the persisted tuple with zero fiscal/audit writes and does not unlock PDF after a matching lookup", async () => {
    const invoiceId = await seedIssued({ cae: null, cbteNro: 7 });
    const snapshot = { rowId: "row", name: "ACME S.A.", cuit: "20123456786", recipientMode: "identified" as const, taxRate: 21, date: "2026-09-22", amount: 121000, issuerCuit: "30710145764", issuerName: "TEST", issuerCondition: "monotributista" as const, ptoVta: 1, environment: "homologacion" as const };
    await db.update(invoices).set({ status: "EMIT_FAILED", approvalSnapshot: snapshot }).where(eq(invoices.id, invoiceId));
    await db.update(issuedInvoices).set({ cuit: snapshot.issuerCuit }).where(eq(issuedInvoices.invoiceId, invoiceId));
    const before = { invoices: await db.select().from(invoices), issued: await db.select().from(issuedInvoices), audits: await db.select().from(auditLog) };
    const pair = generateSelfSignedCert("OFFLINE TEST");
    const stored = { certPem: pair.certPem, encryptedKey: encryptPrivateKey(pair.keyPem, deriveAesKey("01".repeat(32))) };
    const key = `${WSAA_HOMOLOGACION_URL}:${inspectCertificate(pair.certPem).fingerprint}:wsfe`;
    const query = createInvoiceConsultation({
      env: { ARCA_ENV: "homologacion", AES_KEY: "01".repeat(32), EMISSIONS_ENABLED: "false" },
      getReservation: id => loadReservedInvoice(db, id), repository: { get: async () => stored },
      store: { get: async k => k === key ? { token: "TOKEN", sign: "SIGN", expiresAt: Date.now() + 3600000, issuedAt: Date.now() } : null, put: async () => { throw new Error("Unexpected cache write"); } },
      fetchFn: async (_url, init) => {
        expect(init?.body).toContain("<ar:Cuit>30710145764</ar:Cuit>");
        expect(init?.body).toContain("<ar:CbteNro>7</ar:CbteNro>");
        expect(init?.body).not.toMatch(/FECAESolicitar|FECompUltimoAutorizado/);
        return new Response(`<Envelope><Body><FECompConsultarResponse><FECompConsultarResult><ResultGet><Resultado>A</Resultado><EmisionTipo>CAE</EmisionTipo><CodAutorizacion>70212345678901</CodAutorizacion><FchVto>20261002</FchVto><CbteDesde>7</CbteDesde><CbteHasta>7</CbteHasta><CbteFch>20260922</CbteFch><PtoVta>1</PtoVta><CbteTipo>1</CbteTipo><DocTipo>80</DocTipo><DocNro>20123456786</DocNro><ImpTotal>1210.00</ImpTotal><ImpNeto>1000.00</ImpNeto><ImpIVA>210.00</ImpIVA><MonId>PES</MonId><MonCotiz>1</MonCotiz></ResultGet></FECompConsultarResult></FECompConsultarResponse></Body></Envelope>`);
      },
    });
    expect(await query(invoiceId)).toMatchObject({ status: "matched", cae: "70212345678901" });
    expect({ invoices: await db.select().from(invoices), issued: await db.select().from(issuedInvoices), audits: await db.select().from(auditLog) }).toEqual(before);
    expect(await listIssuedInvoices(db)).toEqual([]);
    expect(await loadIssuedInvoicePdfInput(db, invoiceId)).toBeNull();
    expect(await listReservedAttempts(db)).toEqual([expect.objectContaining({ invoiceId, status: "EMIT_FAILED", canConsult: true })]);
  });
});
