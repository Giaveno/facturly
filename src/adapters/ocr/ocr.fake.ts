/**
 * Deterministic in-memory OCR fake. It never reads pixels — it dispatches on a
 * single marker byte at offset 0 so tests and the offline pipeline can select a
 * scenario with zero network or real model:
 *
 *   0x00 → "confident"      (legible fields + a checksum-valid CUIT)
 *   0x01 → "lowConfidence"  (fields present but below threshold → BLOCKED)
 *   else → "noCuit"         (legible fields, NO CUIT → registry resolution)
 */

import type { OcrExtractResult, OcrProvider } from "@/ports/ocr-provider";

export type OcrFakeScenario = "confident" | "lowConfidence" | "noCuit";

// A Mod-11-valid CUIT (slice-1 vector: 23000000809).
const CONFIDENT_CUIT = "23000000809";

const SCENARIOS: Record<OcrFakeScenario, OcrExtractResult> = {
  confident: {
    fields: {
      name: "ACME S.A.",
      cbu: "0110599520000001234567",
      amount: 123456, // $1234.56
      date: "2026-09-22",
      opNumber: "123456789012",
    },
    confidence: {
      name: 0.98,
      cbu: 0.99,
      amount: 0.97,
      date: 0.96,
      opNumber: 0.95,
    },
    cuit: CONFIDENT_CUIT,
  },
  lowConfidence: {
    fields: {
      name: "LEGIBLE? S.R.L.",
      cbu: "0110599520000007654321",
      amount: 9990, // $99.90
      date: "2026-09-22",
    },
    confidence: { name: 0.42, cbu: 0.55, amount: 0.61 },
    cuit: undefined,
  },
  noCuit: {
    fields: {
      name: "PAGOS DELTA SRL",
      cvu: "0000003100000000000001",
      alias: "delta.pagos",
      amount: 5500, // $55.00
      date: "2026-09-21",
    },
    confidence: { name: 0.94, cvu: 0.97, alias: 0.93, amount: 0.98, date: 0.95 },
    cuit: undefined,
  },
};

export function detectScenario(image: Uint8Array): OcrFakeScenario {
  if (image[0] === 0x00) return "confident";
  if (image[0] === 0x01) return "lowConfidence";
  return "noCuit";
}

export class OcrFake implements OcrProvider {
  async extract(image: Uint8Array): Promise<OcrExtractResult> {
    const result = SCENARIOS[detectScenario(image)];
    // Return a deep copy so callers cannot mutate the shared fixture.
    return structuredClone(result);
  }
}
