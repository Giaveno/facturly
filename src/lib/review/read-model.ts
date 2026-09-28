/**
 * Review read-model — the rows shown on the review screen, joined to their
 * client. This is a read concern unrelated to ingestion, so it lives here
 * rather than in the upload pipeline.
 */

import { eq } from "drizzle-orm";
import { batches, clients, ocrRows, photos } from "@/lib/db/schema";
import type { OcrFields } from "@/ports/ocr-provider";
import type { Db } from "@/lib/db/types";

export interface ReviewRow {
  rowId: string;
  status: string;
  cuit: string | null;
  fields: OcrFields;
  clientId: string;
  razonSocial: string;
  /** UI hint only — see `isRowEmittable` for the real enforcement. */
  blocked: boolean;
  /** True when the async OCR crashed — actionable, never emittable (W7). */
  failed: boolean;
  /** The OCR failure reason, when `failed` is true. */
  error: string | null;
}

/**
 * Lists rows for the review table, joined to their client, with a `blocked`
 * flag the UI uses to hide the approve action (blocked rows are unapprovable).
 * The flag is a presentation hint; emission enforcement lives in
 * `@/domain/emission`.
 */
export async function listReviewRows(db: Db): Promise<ReviewRow[]> {
  const rows = await db
    .select({
      rowId: ocrRows.id,
      status: ocrRows.status,
      cuit: ocrRows.cuit,
      fields: ocrRows.fields,
      clientId: batches.clientId,
      razonSocial: clients.razonSocial,
      error: ocrRows.error,
    })
    .from(ocrRows)
    .innerJoin(photos, eq(ocrRows.photoId, photos.id))
    .innerJoin(batches, eq(photos.batchId, batches.id))
    .innerJoin(clients, eq(batches.clientId, clients.id))
    .orderBy(ocrRows.createdAt);

  return rows.map((r) => ({
    ...r,
    blocked: r.status === "BLOCKED",
    failed: r.status === "FAILED",
  }));
}
