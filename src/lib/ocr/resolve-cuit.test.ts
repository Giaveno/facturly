import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestDb } from "@/test-support/test-db";
import { payers } from "@/lib/db/schema";
import { resolveRowCuit } from "./resolve-cuit";
import type { OcrExtractResult } from "@/ports/ocr-provider";
import type { Db } from "@/lib/db/types";

describe("resolveRowCuit — OCR CUIT vs registry CUIT", () => {
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

  const ocrResult = (fields: Partial<OcrExtractResult["fields"]>, cuit?: string): OcrExtractResult => ({
    fields: { name: "ACME S.A.", amount: 1000, date: "2026-09-22", ...fields },
    confidence: { name: 0.9, amount: 0.9 },
    cuit,
  });

  it("keeps a valid OCR CUIT and never overrides it with a registry CUIT", async () => {
    // A payer exists with the same CBU but a DIFFERENT stored CUIT — the OCR's
    // own extraction must win.
    await db.insert(payers).values({
      name: "ACME",
      cbu: "0110599520000001234567",
      cuit: "30710145764",
      learnedFrom: "manual",
    });

    const result = await resolveRowCuit(
      db,
      ocrResult({ cbu: "0110599520000001234567" }, "23000000809"),
    );

    expect(result).toEqual({ cuit: "23000000809", cuitSource: "ocr", matchedBy: null });
  });

  it("resolves a missing CUIT from the registry with matchedBy 'cbu'", async () => {
    await db.insert(payers).values({
      name: "ACME",
      cbu: "0110599520000001234567",
      cuit: "30710145764",
      learnedFrom: "manual",
    });

    const result = await resolveRowCuit(
      db,
      ocrResult({ cbu: "0110599520000001234567" }),
      "identified",
    );

    expect(result).toEqual({ cuit: "30710145764", cuitSource: "registry", matchedBy: "cbu" });
  });

  it("leaves the CUIT absent when no registry payer matches", async () => {
    const result = await resolveRowCuit(
      db,
      ocrResult({ cbu: "0110599520000009999999" }),
      "identified",
    );

    expect(result).toEqual({ cuit: null, cuitSource: null, matchedBy: null });
  });
  it("does not even access the registry for default anonymous extraction",async()=>{
    const blockedDb=new Proxy({} as Db,{get(){throw new Error("Registry must not be consulted");}});
    expect(await resolveRowCuit(blockedDb,ocrResult({name:"Known payer"}))).toEqual({cuit:null,cuitSource:null,matchedBy:null});
  });
});
