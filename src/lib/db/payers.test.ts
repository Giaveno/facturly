import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { createTestDb } from "@/test-support/test-db";
import { payers } from "./schema";
import {
  normalizePayerName,
  upsertPayer,
  PayerAmbiguityError,
} from "./payers";
import type { Db } from "./types";

describe("normalizePayerName", () => {
  it("uppercases and trims", () => {
    expect(normalizePayerName("  acme s.a.  ")).toBe("ACME");
  });

  it("strips accents", () => {
    expect(normalizePayerName("José García")).toBe("JOSE GARCIA");
    expect(normalizePayerName("NIÑO S.A.")).toBe("NINO");
  });

  it("collapses internal whitespace", () => {
    expect(normalizePayerName("PAGOS   DELTA    SRL")).toBe("PAGOS DELTA");
  });

  it("drops legal-form suffixes (S.A., SRL, S.R.L.)", () => {
    expect(normalizePayerName("EMPRESA EJEMPLO S.A.")).toBe("EMPRESA EJEMPLO");
    expect(normalizePayerName("EMPRESA EJEMPLO S.A")).toBe("EMPRESA EJEMPLO");
    expect(normalizePayerName("COMERCIO SRL")).toBe("COMERCIO");
    expect(normalizePayerName("COMERCIO S.R.L.")).toBe("COMERCIO");
  });

  it("does not mangle names whose final letters merely resemble a suffix", () => {
    // "LA CASA" ends in "SA" but has no preceding whitespace → untouched.
    expect(normalizePayerName("LA CASA")).toBe("LA CASA");
  });

  it("rejects an empty name", () => {
    expect(() => normalizePayerName("")).toThrow();
    expect(() => normalizePayerName("   ")).toThrow();
  });

  it("rejects a name that is only a legal-form suffix", () => {
    expect(() => normalizePayerName("S.A.")).toThrow();
    expect(() => normalizePayerName("SRL")).toThrow();
  });
});

describe("upsertPayer", () => {
  let db: Db;
  let close: () => Promise<void>;

  // One migrated DB shared by the whole file; each test starts from an empty
  // payer registry via the beforeEach cleanup. This avoids re-running the full
  // migration (~2s) for every test.
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });

  beforeEach(async () => {
    await db.delete(payers);
  });

  afterAll(async () => {
    await close();
  });

  const allPayers = () => db.select().from(payers);

  it("inserts a new payer with learnedFrom='manual'", async () => {
    const result = await upsertPayer(db, {
      name: "EMPRESA NUEVA S.A.",
      cbu: "0110599520000001111111",
      cuit: "20123456786",
    });
    expect(result.inserted).toBe(true);
    expect(result.learnedFrom).toBe("manual");
  });

  it("matches an existing payer by CBU and persists the corrected CUIT", async () => {
    await upsertPayer(db, {
      name: "EMPRESA NUEVA S.A.",
      cbu: "0110599520000001111111",
    });
    const result = await upsertPayer(db, {
      name: "EMPRESA NUEVA S.A.",
      cbu: "0110599520000001111111",
      cuit: "30710145764",
    });
    expect(result.inserted).toBe(false);

    // The registry learned the corrected CUIT — assert the PERSISTED value,
    // not just that a subsequent lookup "did not insert".
    const rows = await allPayers();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cuit).toBe("30710145764");
  });

  it("matches by alias too (not only CBU)", async () => {
    await upsertPayer(db, {
      name: "PAGOS DELTA",
      alias: "delta.pagos",
      cuit: "20123456786",
    });
    const result = await upsertPayer(db, {
      name: "PAGOS DELTA",
      alias: "delta.pagos",
    });
    expect(result.inserted).toBe(false);
  });

  it("corrects a name-only payer (UPDATE, not duplicate)", async () => {
    // First pass: only the name is known (no CBU/CVU/alias).
    await upsertPayer(db, { name: "PAGOS DELTA SRL" });

    // Later a correction arrives with the same legal name + a CUIT.
    const result = await upsertPayer(db, {
      name: "PAGOS DELTA S.R.L.",
      cuit: "20123456786",
    });
    expect(result.inserted).toBe(false);

    const rows = await allPayers();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cuit).toBe("20123456786");
    expect(rows[0]!.name).toBe("PAGOS DELTA");
  });

  it("inserts a distinct row when no key matches", async () => {
    await upsertPayer(db, { name: "UNO SRL", cbu: "0110599520000002222222" });
    const result = await upsertPayer(db, {
      name: "DOS SRL",
      cbu: "0110599520000003333333",
    });
    expect(result.inserted).toBe(true);
  });

  it("throws when CBU and alias resolve to DIFFERENT payers", async () => {
    await upsertPayer(db, {
      name: "PAYER ONE SRL",
      cbu: "0110599520000004444444",
    });
    await upsertPayer(db, {
      name: "PAYER TWO SRL",
      alias: "payer.two",
    });

    // cbu matches PAYER ONE, alias matches PAYER TWO → must NOT silently pick one.
    await expect(
      upsertPayer(db, {
        name: "UNRELATED NAME SRL",
        cbu: "0110599520000004444444",
        alias: "payer.two",
      }),
    ).rejects.toThrow(PayerAmbiguityError);
  });

  it("throws on an ambiguous name-only match (two payers share the name)", async () => {
    // Two payers that share a normalized name (legacy duplicates — e.g. data
    // written before name matching existed). Inserted directly to bypass the
    // name-collapsing in upsertPayer.
    await db.insert(payers).values({
      name: "ACME",
      cbu: "0110599520000005555555",
      learnedFrom: "manual",
    });
    await db.insert(payers).values({
      name: "ACME",
      cbu: "0110599520000006666666",
      learnedFrom: "manual",
    });

    // A correction keyed only by the shared name matches two distinct payers.
    await expect(
      upsertPayer(db, { name: "ACME S.R.L.", cuit: "20123456786" }),
    ).rejects.toThrow(PayerAmbiguityError);
  });
});
