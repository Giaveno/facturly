import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { emitBatchJob } from "@/jobs/emit";
import { processOcrRowJob } from "@/jobs/ocr";

/**
 * Inngest endpoint (Next.js app router). Serves BOTH background jobs so the
 * emission pipeline and the async OCR path are actually reachable in
 * production (C4 — previously there was no `serve(...)` anywhere).
 *
 * Thin wiring: the jobs delegate to offline-tested services (`emitBatch`,
 * `processOcrRow`); the functions themselves are not exercised in the offline
 * suite (they require the Inngest platform / dev server).
 */
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [emitBatchJob, processOcrRowJob],
});
