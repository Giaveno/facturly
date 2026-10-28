/**
 * OCR-path CUIT decision — the glue between OCR extraction and the payer
 * registry, shared by the synchronous (`processUpload`) and asynchronous
 * (`processOcrRow`) ingest paths.
 *
 * A valid CUIT the OCR itself extracted ALWAYS wins — the registry must never
 * override it. When the image carries no CUIT (the common bank-transfer case),
 * the registry read side tries to resolve one from CBU/CVU/alias/name. If it
 * cannot decide, the CUIT stays absent and the row remains flagged for review.
 */

import { isValidCuit } from "@/domain/cuit";
import {
  resolvePayerCuitFromRegistry,
  type PayerMatchKey,
} from "@/lib/db/payers";
import type { CuitSource } from "@/lib/db/schema";
import type { OcrExtractResult } from "@/ports/ocr-provider";
import type { Db } from "@/lib/db/types";

export interface ResolvedRowCuit {
  cuit: string | null;
  cuitSource: CuitSource | null;
  matchedBy: PayerMatchKey | null;
}

/**
 * Decides a row's CUIT from an OCR result, falling back to the registry when the
 * image carries no valid CUIT. Pure read (no row write, no audit) — the caller
 * persists the CUIT and records the audit entry.
 */
export async function resolveRowCuit(
  db: Db,
  result: OcrExtractResult,
): Promise<ResolvedRowCuit> {
  const ocrCuit = result.cuit && isValidCuit(result.cuit) ? result.cuit : null;
  if (ocrCuit) {
    return { cuit: ocrCuit, cuitSource: "ocr", matchedBy: null };
  }

  const resolved = await resolvePayerCuitFromRegistry(db, {
    name: result.fields.name,
    cbu: result.fields.cbu,
    cvu: result.fields.cvu,
    alias: result.fields.alias,
  });

  if (resolved) {
    return {
      cuit: resolved.cuit,
      cuitSource: "registry",
      matchedBy: resolved.matchedBy,
    };
  }

  return { cuit: null, cuitSource: null, matchedBy: null };
}
