import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { emitBatchJob } from "@/jobs/emit";
import { processOcrRowJob } from "@/jobs/ocr";
import { recoverStuckEmissionsJob } from "@/jobs/recover";

/**
 * Inngest endpoint (Next.js app router). Serves all background jobs so the
 * emission pipeline, the async OCR path, and the scheduled lost-CAE recovery
 * sweeper are actually reachable in production (C2/C4 — previously there was
 * no `serve(...)` anywhere and no schedule trigger for recovery).
 *
 * Thin wiring: the jobs delegate to offline-tested services (`emitBatch`,
 * `processOcrRow`, `recoverStuckEmissions`); the functions themselves are not
 * exercised in the offline suite (they require the Inngest platform / dev
 * server).
 */
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [emitBatchJob, processOcrRowJob, recoverStuckEmissionsJob],
});
