/**
 * Inngest OCR job — THIN adapter over `processOcrRow` (fully tested offline).
 *
 * Moves OCR off the request path: a row is born PENDING and this job promotes it
 * to CONFIDENT/BLOCKED/FAILED. Idempotency: the event carries `rowId` as its key
 * and `processOcrRow` no-ops on any row that is no longer PENDING.
 *
 * The production dependencies (multimodal-LLM OCR adapter, storage reader) are
 * slice-5 wiring and fail loudly until injected — the job never silently uses
 * the in-memory fake in production (a crashed extraction is marked FAILED, W7).
 *
 * `step.run` wraps the extraction so its output is memoized across retries.
 */

import { inngest } from "@/lib/inngest/client";
import { processOcrRow, type ImageReader } from "@/lib/ocr/process";
import { getDb } from "@/lib/db/client";
import type { OcrProvider } from "@/ports/ocr-provider";
import { LocalReceiptStorage } from "@/adapters/storage/local-receipt-storage";
import { createConfiguredOcrProvider } from "@/adapters/ocr/ocr.gemini";

// Gemini is used only by the authenticated server-side async OCR job and only
// when explicitly opted in with OCR_PROVIDER=gemini.
const ocrProvider: OcrProvider = createConfiguredOcrProvider();
const readImage: ImageReader = (key) => new LocalReceiptStorage().get(key);

export const processOcrRowJob = inngest.createFunction(
  {
    id: "ocr/process-row",
    triggers: [{ event: "ocr/row.pending" }],
    retries: 3,
  },
  async ({ event, step }) => {
    const rowId = event.data.rowId as string;
    const result = await step.run("process-ocr-row", () =>
      processOcrRow(getDb(), ocrProvider, rowId, readImage),
    );
    return { rowId: result.id, status: result.status };
  },
);
