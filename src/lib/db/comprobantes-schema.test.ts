import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test-support/test-db";
import { clients, comprobantes } from "./schema";

describe("comprobantes database invariants", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });

  afterAll(async () => {
    await close();
  });

  beforeEach(async () => {
    await db.delete(comprobantes);
    await db.delete(clients);
  });

  const company = async (cuit: string) => {
    const [row] = await db.insert(clients).values({
      cuit,
      razonSocial: `Empresa ${cuit}`,
      ptoVta: 1,
      condicionIva: "ri",
    }).returning();
    return row!.id;
  };

  const comprobante = (empresaId: string, overrides: Partial<typeof comprobantes.$inferInsert> = {}) => ({
    empresaId,
    ambiente: "homologacion" as const,
    emisorCuit: "30710145764",
    emisorCondicionIva: "ri" as const,
    cbteTipo: 1,
    ptoVta: 1,
    cbteNro: 1,
    docTipo: 80,
    docNro: "30710145764",
    condicionIvaReceptor: 1,
    fecha: "2026-10-29",
    importeNetoCentavos: 100,
    importeIvaCentavos: 0,
    importeExentoCentavos: 0,
    importeTributosCentavos: 0,
    importeTotalCentavos: 100,
    items: [],
    estado: "pendiente" as const,
    idempotencyKey: crypto.randomUUID(),
    ...overrides,
  });

  it("scopes idempotency to empresa and excludes rejected rows from fiscal uniqueness", async () => {
    const empresaA = await company("30710145764");
    const empresaB = await company("30710145772");
    await db.insert(comprobantes).values(comprobante(empresaA, { idempotencyKey: "same-key" }));

    await expect(db.insert(comprobantes).values(comprobante(empresaA, { idempotencyKey: "same-key", cbteNro: 2 }))).rejects.toThrow();
    await db.insert(comprobantes).values(comprobante(empresaB, { idempotencyKey: "same-key", cbteNro: 2 }));
    await expect(db.insert(comprobantes).values(comprobante(empresaA, { idempotencyKey: "other-key" }))).rejects.toThrow();
    await db.insert(comprobantes).values(comprobante(empresaA, { idempotencyKey: "rejected-key", estado: "rechazado" }));
  });

  it("keeps official document catalogs in application validation, not database checks", async () => {
    const empresaId = await company("30710145764");
    const [row] = await db.insert(comprobantes).values(comprobante(empresaId, {
      idempotencyKey: "catalog-boundary",
      cbteNro: null,
      estado: "borrador",
      docTipo: 123,
      condicionIvaReceptor: 999,
    })).returning();
    expect(row!.docTipo).toBe(123);
    expect(row!.condicionIvaReceptor).toBe(999);
  });

  it("enforces issuer CUIT, number bounds, and pending/approved prerequisites", async () => {
    const empresaId = await company("30710145764");
    await expect(db.insert(comprobantes).values(comprobante(empresaId, { idempotencyKey: "bad-cuit", emisorCuit: "123" }))).rejects.toThrow();
    await expect(db.insert(comprobantes).values(comprobante(empresaId, { idempotencyKey: "bad-number", cbteNro: 100_000_000 }))).rejects.toThrow();
    await expect(db.insert(comprobantes).values(comprobante(empresaId, { idempotencyKey: "pending-without-number", cbteNro: null }))).rejects.toThrow();
    await expect(db.insert(comprobantes).values(comprobante(empresaId, { idempotencyKey: "approved-without-cae", estado: "aprobado" }))).rejects.toThrow();
  });

  it("supports a self-referencing associated comprobante", async () => {
    const empresaId = await company("30710145764");
    const [original] = await db.insert(comprobantes).values(comprobante(empresaId, { idempotencyKey: "original", cbteNro: null, estado: "borrador" })).returning();
    const [associated] = await db.insert(comprobantes).values(comprobante(empresaId, { idempotencyKey: "associated", cbteNro: null, estado: "borrador", comprobanteAsociadoId: original!.id })).returning();
    const [read] = await db.select().from(comprobantes).where(eq(comprobantes.id, associated!.id));
    expect(read!.comprobanteAsociadoId).toBe(original!.id);
  });
});
