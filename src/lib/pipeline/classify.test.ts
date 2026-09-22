import { describe, it, expect } from "vitest";
import { classifyOcrRowStatus } from "./ingest";
import { OCR_CONFIDENCE_THRESHOLD } from "@/ports/ocr-provider";

describe("classifyOcrRowStatus — confidence policy", () => {
  it("classifies all-above-threshold fields as CONFIDENT", () => {
    expect(
      classifyOcrRowStatus({ name: 0.98, cbu: 0.99, amount: 0.97 }),
    ).toBe("CONFIDENT");
  });

  it("classifies all-below-threshold fields as BLOCKED", () => {
    expect(
      classifyOcrRowStatus({ name: 0.42, cbu: 0.55, amount: 0.61 }),
    ).toBe("BLOCKED");
  });

  it("classifies a single field exactly AT the threshold as CONFIDENT (strict <)", () => {
    expect(
      classifyOcrRowStatus({ name: OCR_CONFIDENCE_THRESHOLD }),
    ).toBe("CONFIDENT");
  });

  it("classifies a mix where one field is below threshold as BLOCKED", () => {
    expect(
      classifyOcrRowStatus({
        name: 0.99,
        amount: OCR_CONFIDENCE_THRESHOLD - 0.01,
      }),
    ).toBe("BLOCKED");
  });

  it("classifies an empty confidence map as BLOCKED", () => {
    expect(classifyOcrRowStatus({})).toBe("BLOCKED");
  });

  it("classifies NaN confidence as BLOCKED (non-finite is not confident)", () => {
    // NaN < threshold is false, so a naive `.some(v => v < threshold)` would
    // silently yield CONFIDENT. We require finite numbers.
    expect(classifyOcrRowStatus({ name: NaN })).toBe("BLOCKED");
  });
});
