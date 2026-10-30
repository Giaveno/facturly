/** Review approvals use only the canonical fiscal service and a stable invoice key. */
import { inngest } from "@/lib/inngest/client";
import { emitReviewedBatch } from "@/lib/emission/review-emission-service";
import { buildArcaGateway } from "@/lib/emission/gateway";
import { readEmissionsEnabled } from "@/adapters/arca/emissions";
import { getDb } from "@/lib/db/client";

export const emitBatchJob = inngest.createFunction(
  {
    id: "emit/batch",
    triggers: [{ event: "emit/batch.requested" }],
    retries: 3,
    // C3: idempotency keyed on the sender-provided key (per-invoice approval
    // uses the invoiceId; an explicit batch action uses a batch-derived key).
    idempotency: "event.data.idempotencyKey",
  },
  async ({ event, step }) => {
    const invoiceIds = event.data.invoiceIds as string[] | undefined;
    const emissionsEnabled = readEmissionsEnabled();
    if (!emissionsEnabled) {
      return { emitted: 0, alreadyEmitted: 0, failed: 0, outcomes: [], skipped: true, reason: "emissions-disabled" };
    }
    const results = await step.run("emit-batch", () =>
      emitReviewedBatch(
        {
          db: getDb(),
          gateway: buildArcaGateway(getDb()),
          env: process.env,

        },
        invoiceIds,
      ),
    );
    return {
      emitted: results.filter(result => result.outcome === "emitted").length,
      alreadyEmitted: results.filter(result => result.outcome === "already_emitted").length,
      failed: results.filter(result => result.outcome.startsWith("failed_")).length,
      outcomes: results.map(({ invoiceId, outcome, stage, category, arcaCode, providerCodes, httpStatus }) => ({
        invoiceId, outcome, stage, category, arcaCode, providerCodes, httpStatus,
      })),
    };
  },
);


