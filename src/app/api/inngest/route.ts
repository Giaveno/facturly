import { cleanupReceiptsJob } from "@/jobs/cleanup-receipts";
import { serve, type RequestHandler } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { resolveInngestSigningKey } from "@/lib/inngest/config";
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
const inngestHandlers = serve({
  client: inngest,
  functions: [emitBatchJob, processOcrRowJob, recoverStuckEmissionsJob, cleanupReceiptsJob],
});

/**
 * Wraps each Inngest handler with a production assertion that refuses (throws)
 * when the endpoint is misconfigured: `INNGEST_SIGNING_KEY` missing, or
 * `INNGEST_DEV` set (which disables signature verification). It runs at REQUEST
 * time, not module load, because route modules are evaluated during
 * `next build` where the key is not present.
 */
function guard(handler: RequestHandler): RequestHandler {
  return async (req, res) => {
    resolveInngestSigningKey();
    return handler(req, res);
  };
}

export const GET = guard(inngestHandlers.GET);
export const POST = guard(inngestHandlers.POST);
export const PUT = guard(inngestHandlers.PUT);
