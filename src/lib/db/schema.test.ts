import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test-support/test-db";
import {
  auditLog,
  batches,
  clients,
  credentials,
  delegations,
  invoices,
  issuedInvoices,
  ocrRows,
  photos,
  payers,
} from "./schema";
import type { Db } from "./types";

/**
 * DB-level schema guarantees that unit tests can't reach: bigint width for
 * 11-digit CUITs, the cbte_tipo CHECK, and the clients.cuit UNIQUE index.
 */
describe("schema guarantees", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });

  afterAll(async () => {
    await close();
  });

  // Per-test isolation: wipe every table (in FK-dependency order) so each test
  // starts from a clean DB instead of relying on distinct hardcoded CUITs.
  beforeEach(async () => {
    await db.delete(auditLog);
    await db.delete(issuedInvoices);
    await db.delete(invoices);
    await db.delete(ocrRows);
    await db.delete(photos);
    await db.delete(batches);
    await db.delete(payers);
    await db.delete(delegations);
    await db.delete(credentials);
    await db.delete(clients);
  });

  const seedRow = async (clientId: string) => {
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
        fields: { name: "PAGADOR", amount: 100, date: "2026-09-22" },
        confidence: { name: 0.9, amount: 0.9 },
        status: "CONFIDENT",
      })
      .returning();
    return { rowId: row!.id };
  };

  it("stores and reads back an 11-digit receptor CUIT (30710145764)", async () => {
    const [client] = await db
      .insert(clients)
      .values({
        cuit: "20123456786",
        razonSocial: "EMISOR S.A.",
        ptoVta: 1,
        condicionIva: "ri",
      })
      .returning();
    const { rowId } = await seedRow(client!.id);

    const receptorCuit = 30710145764; // 11 digits, overflows a 32-bit integer
    const [invoice] = await db
      .insert(invoices)
      .values({
        ocrRowId: rowId,
        clientId: client!.id,
        receptorDocNro: receptorCuit,
      })
      .returning();
    expect(invoice!.receptorDocNro).toBe(receptorCuit);

    const [read] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.id, invoice!.id));
    expect(read!.receptorDocNro).toBe(receptorCuit);
  });

  it("rejects a cbte_tipo outside 1|6|11 (CHECK constraint)", async () => {
    const [client] = await db
      .insert(clients)
      .values({
        cuit: "20123456781",
        razonSocial: "EMISOR B S.A.",
        ptoVta: 1,
        condicionIva: "ri",
      })
      .returning();
    const { rowId } = await seedRow(client!.id);

    await expect(
      db.insert(invoices).values({
        ocrRowId: rowId,
        clientId: client!.id,
        cbteTipo: 7,
      }),
    ).rejects.toThrow();
  });

  it("rejects a duplicate clients.cuit (UNIQUE index)", async () => {
    const base = {
      cuit: "30710145764",
      razonSocial: "UNICO S.A.",
      ptoVta: 1,
      condicionIva: "monotributista" as const,
    };
    await db.insert(clients).values(base);
    await expect(db.insert(clients).values(base)).rejects.toThrow();
  });

  it("rejects a second delegation row for the same client (UNIQUE index)", async () => {
    const [client] = await db
      .insert(clients)
      .values({ cuit: "30710145764", razonSocial: "UNICO S.A.", ptoVta: 1, condicionIva: "ri" })
      .returning();

    await db
      .insert(delegations)
      .values({ clientId: client!.id, cuit: "30710145764", enabled: true });
    await expect(
      db.insert(delegations).values({ clientId: client!.id, cuit: "30710145764", enabled: false }),
    ).rejects.toThrow();
  });

  it("rejects a second credentials row on the singleton scope (UNIQUE index)", async () => {
    const row = {
      certPem: "-----BEGIN CERTIFICATE-----\nCERT\n-----END CERTIFICATE-----",
      keyCiphertext: "AA==",
      iv: "AAAAAAAAAAAAAAAAAAAAAA==",
      authTag: "AAAAAAAAAAAAAAAAAAAAAA==",
    };
    await db.insert(credentials).values(row);
    await expect(db.insert(credentials).values(row)).rejects.toThrow();
  });
});
