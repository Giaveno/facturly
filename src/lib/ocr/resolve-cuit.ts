/**
 * OCR-path CUIT decision — the glue between OCR extraction and the payer
 * registry, shared by the synchronous (`processUpload`) and asynchronous
 * (`processOcrRow`) ingest paths.
 *
 * Direct OCR evidence is retained without selecting a recipient mode. Anonymous
 * extraction never consults the registry. Only an explicitly identified legacy
 * pending row may fall back to registry evidence when OCR has no valid CUIT.
 */

import { isValidCuit } from "@/domain/cuit";
import type { RecipientMode } from "@/domain/receipt";
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
 * Decides CUIT evidence, with registry fallback only in identified mode.
 * Pure read (no row write, no audit) — the caller
 * persists the CUIT and records the audit entry.
 */
export async function resolveRowCuit(
  db: Db,
  result: OcrExtractResult,
  recipientMode: RecipientMode = "consumer_final",
): Promise<ResolvedRowCuit> {
  const ocrCuit = result.cuit && isValidCuit(result.cuit) ? result.cuit : null;
  if (ocrCuit) {
    return { cuit: ocrCuit, cuitSource: "ocr", matchedBy: null };
  }
  // Anonymous mode may retain direct OCR evidence, never infer a fiscal
  // identifier through registry matching (or produce a resolution audit).
  if (recipientMode === "consumer_final") return {cuit:null,cuitSource:null,matchedBy:null};

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
