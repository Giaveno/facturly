import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestDb } from "@/test-support/test-db";
import { payers } from "./schema";
import { resolvePayerCuitFromRegistry } from "./payers";
import type { Db } from "./types";

describe("resolvePayerCuitFromRegistry — the registry READ side", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });

  beforeEach(async () => {
    await db.delete(payers);
  });

  afterAll(async () => {
    await close();
  });

  const seedPayer = (p: {
    name: string;
    cbu?: string;
    cvu?: string;
    alias?: string;
    cuit?: string;
  }) =>
    db
      .insert(payers)
      .values({
        name: p.name,
        cbu: p.cbu ?? null,
        cvu: p.cvu ?? null,
        alias: p.alias ?? null,
        cuit: p.cuit ?? null,
        learnedFrom: "manual",
      })
      .returning();

  it("resolves a known payer by CBU with matchedBy 'cbu'", async () => {
    await seedPayer({ name: "ACME", cbu: "0110599520000001234567", cuit: "30710145764" });
    const result = await resolvePayerCuitFromRegistry(db, {
      name: "ACME S.A.",
      cbu: "0110599520000001234567",
    });
    expect(result).toEqual({ cuit: "30710145764", matchedBy: "cbu" });
  });

  it("resolves by CVU with matchedBy 'cvu'", async () => {
    await seedPayer({ name: "PAGOS DELTA", cvu: "0000003100000000000001", cuit: "20123456786" });
    const result = await resolvePayerCuitFromRegistry(db, {
      name: "PAGOS DELTA SRL",
      cvu: "0000003100000000000001",
    });
    expect(result).toEqual({ cuit: "20123456786", matchedBy: "cvu" });
  });

  it("resolves by alias with matchedBy 'alias'", async () => {
    await seedPayer({ name: "PAGOS DELTA", alias: "delta.pagos", cuit: "20123456786" });
    const result = await resolvePayerCuitFromRegistry(db, {
      name: "PAGOS DELTA SRL",
      alias: "delta.pagos",
    });
    expect(result).toEqual({ cuit: "20123456786", matchedBy: "alias" });
  });

  it("resolves by normalized name (accents + suffix) with matchedBy 'name'", async () => {
    await seedPayer({ name: "JOSE GARCIA", cuit: "23000000809" });
    const result = await resolvePayerCuitFromRegistry(db, {
      name: "José García S.A.",
    });
    expect(result).toEqual({ cuit: "23000000809", matchedBy: "name" });
  });

  it("prefers the strongest key (CBU) when several keys match the SAME payer", async () => {
    await seedPayer({
      name: "PAGOS DELTA",
      cbu: "0110599520000001234567",
      alias: "delta.pagos",
      cuit: "30710145764",
    });
    const result = await resolvePayerCuitFromRegistry(db, {
      name: "PAGOS DELTA SRL",
      cbu: "0110599520000001234567",
      alias: "delta.pagos",
    });
    expect(result).toEqual({ cuit: "30710145764", matchedBy: "cbu" });
  });

  it("returns null for an unknown payer", async () => {
    const result = await resolvePayerCuitFromRegistry(db, {
      name: "UNKNOWN CO",
      cbu: "0110599520000009999999",
    });
    expect(result).toBeNull();
  });

  it("returns null when two distinct payers match different keys (never guess)", async () => {
    await seedPayer({ name: "PAYER ONE", cbu: "0110599520000004444444", cuit: "20123456786" });
    await seedPayer({ name: "PAYER TWO", alias: "payer.two", cuit: "30710145764" });
    const result = await resolvePayerCuitFromRegistry(db, {
      name: "UNRELATED",
      cbu: "0110599520000004444444",
      alias: "payer.two",
    });
    expect(result).toBeNull();
  });

  it("does not return a CUIT that fails the Mod-11 check (corrupt registry value)", async () => {
    await seedPayer({ name: "ACME", cbu: "0110599520000001234567", cuit: "20123456789" });
    const result = await resolvePayerCuitFromRegistry(db, {
      name: "ACME S.A.",
      cbu: "0110599520000001234567",
    });
    expect(result).toBeNull();
  });

  it("returns null when the matched payer has no CUIT yet (never learned)", async () => {
    await seedPayer({ name: "ACME", cbu: "0110599520000001234567" });
    const result = await resolvePayerCuitFromRegistry(db, {
      name: "ACME S.A.",
      cbu: "0110599520000001234567",
    });
    expect(result).toBeNull();
  });
});
