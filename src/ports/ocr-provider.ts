/**
 * Port: OcrProvider — the receipt-OCR boundary.
 *
 * The domain is runtime-neutral (slice 1 deliberately removed Node `Buffer`
 * from `src/domain/` to keep it pure). This port is the boundary, so either
 * `Buffer` or `Uint8Array` is defensible. We choose `Uint8Array`:
 *
 *   - `Buffer` is a Node-only global; `Uint8Array` is an ECMAScript standard
 *     type available in Node, browsers, and edge runtimes.
 *   - `Buffer` IS-A `Uint8Array`, so a Node caller can still pass a `Buffer`
 *     with zero conversion. The contract is strictly more permissive.
 *   - It keeps the whole `src/` tree runtime-neutral, matching slice 1's
 *     decision to drop `Buffer` from the pure domain.
 *
 * The production adapter (slice 4, multimodal LLM) receives image bytes; the
 * fake (slice 2) never reads pixels. A plain byte array satisfies both.
 */

import type { Centavos } from "@/domain/money";

/** Extracted receipt fields. Only `name` and `amount` are always present. */
export interface OcrFields {
  name: string;
  cbu?: string;
  cvu?: string;
  alias?: string;
  amount: Centavos;
  date: string;
  opNumber?: string;
}

/** Result of extracting one receipt image. */
export interface OcrExtractResult {
  fields: OcrFields;
  /** Per-field confidence in [0, 1], keyed by field name ("name", "cbu", ...). */
  confidence: Record<string, number>;
  /** Checksum-validated CUIT (Mod-11), or `undefined` when absent from the image. */
  cuit?: string;
}

/**
 * v1 confidence contract: a row is BLOCKED when any extracted field falls
 * below this threshold. This is a heuristic pending the "per-field confidence
 * contract" open question in the design — but it is applied as a policy here,
 * not baked into the adapters.
 */
export const OCR_CONFIDENCE_THRESHOLD = 0.8;

export interface OcrProvider {
  extract(image: Uint8Array): Promise<OcrExtractResult>;
}
