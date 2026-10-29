/**
 * Offline upload pipeline: group photos under a client, run OCR, persist rows.
 *
 * Slice 2 runs this synchronously — a row is born CONFIDENT or BLOCKED. The
 * PENDING state exists for the async Inngest OCR job (slice 4), where a row is
 * inserted PENDING and later promoted. `classifyOcrRowStatus` is the pure
 * confidence policy shared by both paths.
 */

import { batches, ocrRows, photos } from "@/lib/db/schema";
import { resolveRowCuit } from "@/lib/ocr/resolve-cuit";
import { writeAudit } from "@/lib/audit/audit";
import {
  OCR_CONFIDENCE_THRESHOLD,
  type OcrProvider,
} from "@/ports/ocr-provider";
import type { Db } from "@/lib/db/types";

/**
 * Classifies an OCR result by field confidence:
 *   - any field below the threshold → BLOCKED
 *   - any non-finite (NaN/±Infinity) confidence → BLOCKED (broken extraction)
 *   - otherwise → CONFIDENT (even without a CUIT — resolution is deferred to
 *     the payer registry, per the "Missing CUIT" spec)
 *
 * The comparison is strict `<`, so a field exactly AT the threshold counts as
 * confident.
 */
export function classifyOcrRowStatus(
  confidence: Record<string, number>,
): "CONFIDENT" | "BLOCKED" {
  const values = Object.values(confidence);
  if (values.length === 0) return "BLOCKED";
  return values.some(
    (v) => !Number.isFinite(v) || v < OCR_CONFIDENCE_THRESHOLD,
  )
    ? "BLOCKED"
    : "CONFIDENT";
}

export interface UploadImage {
  storageKey: string;
  image: Uint8Array;
}

export interface ProcessUploadResult {
  batchId: string;
  clientId: string;
  rows: Array<{ id: string; status: string; cuit: string | null }>;
}

/**
 * Groups `images` under `clientId` (one batch), runs OCR per photo, and
 * persists the rows. The batch→photos→rows FK chain guarantees no photo is ever
 * reassigned to another company.
 *
 * The whole batch is one transaction: a failure mid-loop (e.g. the OCR adapter
 * throws on the third photo) rolls back the batch, photos, and rows already
 * written, so a partial batch is never observable.
 */
export async function processUpload(
  clientId: string,
  images: UploadImage[],
  deps: { db: Db; ocr: OcrProvider },
): Promise<ProcessUploadResult> {
  const { db, ocr } = deps;

  return db.transaction(async (tx) => {
    const [batch] = await tx.insert(batches).values({ clientId }).returning();
    if (!batch) throw new Error("processUpload: failed to create batch");

    const rows: ProcessUploadResult["rows"] = [];
    for (const { storageKey, image } of images) {
      const [photo] = await tx
        .insert(photos)
        .values({ batchId: batch.id, storageKey })
        .returning();
      if (!photo) throw new Error("processUpload: failed to create photo");

      const result = await ocr.extract(image);
      const status = classifyOcrRowStatus(result.confidence);

      // New uploads intentionally start anonymous: retain direct OCR evidence
      // only, never infer identity through payer-registry matching.
      const { cuit, cuitSource, matchedBy } = await resolveRowCuit(tx, result, "consumer_final");

      const [row] = await tx
        .insert(ocrRows)
        .values({
          photoId: photo.id,
          fields: result.fields,
          confidence: result.confidence,
          cuit,
          cuitSource,
          status,
        })
        .returning();
      if (!row) throw new Error("processUpload: failed to create ocr_row");

      if (matchedBy) {
        await writeAudit(tx, {
          actor: "system",
          action: "payer.cuit_registry_resolved",
          rowId: row.id,
          payload: { matchedBy },
        });
      }

      rows.push({ id: row.id, status: row.status, cuit: row.cuit });
    }

    return { batchId: batch.id, clientId, rows };
  });
}

/**
 * ASYNC upload path (slice 4): persists batch → photos → PENDING rows WITHOUT
 * running OCR inline. The caller then sends one `ocr/row.pending` Inngest event
 * per row; `processOcrRowJob` promotes each PENDING row to
 * CONFIDENT/BLOCKED/FAILED out of the request path (C4).
 *
 * `processUpload` above remains the SYNCHRONOUS path (used by offline tests to
 * exercise the OCR classification policy in-process); production uses THIS
 * function so OCR is never on the hot request path.
 */
export async function queueUpload(
  clientId: string,
  images: UploadImage[],
  deps: { db: Db },
): Promise<ProcessUploadResult> {
  const { db } = deps;

  return db.transaction(async (tx) => {
    const [batch] = await tx.insert(batches).values({ clientId }).returning();
    if (!batch) throw new Error("queueUpload: failed to create batch");

    const rows: ProcessUploadResult["rows"] = [];
    for (const { storageKey } of images) {
      const [photo] = await tx
        .insert(photos)
        .values({ batchId: batch.id, storageKey })
        .returning();
      if (!photo) throw new Error("queueUpload: failed to create photo");

      // Born PENDING — no extraction yet; the OCR job fills fields/confidence.
      const [row] = await tx
        .insert(ocrRows)
        .values({
          photoId: photo.id,
          fields: { name: "", amount: 0, date: "" },
          confidence: {},
          cuit: null,
          status: "PENDING",
        })
        .returning();
      if (!row) throw new Error("queueUpload: failed to create ocr_row");

      rows.push({ id: row.id, status: "PENDING", cuit: null });
    }

    return { batchId: batch.id, clientId, rows };
  });
}
