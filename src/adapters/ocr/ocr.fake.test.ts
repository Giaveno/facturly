import { describe, it, expect } from "vitest";
import { isValidCuit } from "@/domain/cuit";
import { OCR_CONFIDENCE_THRESHOLD } from "@/ports/ocr-provider";
import { OcrFake, detectScenario, type OcrFakeScenario } from "./ocr.fake";

const imageFor = (scenario: OcrFakeScenario): Uint8Array => {
  if (scenario === "confident") return new Uint8Array([0x00]);
  if (scenario === "lowConfidence") return new Uint8Array([0x01]);
  return new Uint8Array([0x42]); // any other marker byte
};

describe("ocr.fake — deterministic offline scenarios", () => {
  it("detects the scenario from the marker byte", () => {
    expect(detectScenario(imageFor("confident"))).toBe("confident");
    expect(detectScenario(imageFor("lowConfidence"))).toBe("lowConfidence");
    expect(detectScenario(imageFor("noCuit"))).toBe("noCuit");
    expect(detectScenario(new Uint8Array())).toBe("noCuit"); // empty → noCuit
  });

  it("produces a confident row with a checksum-valid CUIT", async () => {
    const fake = new OcrFake();
    const result = await fake.extract(imageFor("confident"));

    expect(result.fields.name).toBe("ACME S.A.");
    expect(result.fields.amount).toBe(123456);
    expect(result.fields.cbu).toBeTruthy();
    expect(result.cuit).toBeDefined();
    // The confident scenario MUST carry a Mod-11-valid CUIT (spec: Confident row).
    expect(isValidCuit(result.cuit as string)).toBe(true);
  });

  it("produces a low-confidence row with no CUIT and below-threshold scores", async () => {
    const fake = new OcrFake();
    const result = await fake.extract(imageFor("lowConfidence"));

    // Every field below the threshold → the pipeline must classify this as BLOCKED.
    for (const score of Object.values(result.confidence)) {
      expect(score).toBeLessThan(OCR_CONFIDENCE_THRESHOLD);
    }
    expect(result.cuit).toBeUndefined();
  });

  it("produces a row with NO CUIT but legible fields (registry resolution)", async () => {
    const fake = new OcrFake();
    const result = await fake.extract(imageFor("noCuit"));

    expect(result.fields.name).toBeTruthy();
    expect(result.fields.cvu ?? result.fields.alias).toBeTruthy();
    expect(result.cuit).toBeUndefined();
  });

  it("does not leak the shared fixture (mutation-safe)", async () => {
    const fake = new OcrFake();
    const a = await fake.extract(imageFor("confident"));
    a.fields.amount = 0;
    a.cuit = "99999999999";

    const b = await fake.extract(imageFor("confident"));
    expect(b.fields.amount).toBe(123456);
    expect(b.cuit).toBe("23000000809");
  });
});
