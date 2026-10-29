/**
 * Inngest emission job — THIN adapter over `emitBatch` (fully tested offline).
 *
 * Emits a batch of APPROVED invoices serially. Idempotency is three-layered:
 *   1. the event carries `idempotencyKey` (declared via `idempotency`) so a
 *      re-sent event for the SAME invoice(s) is deduped by Inngest;
 *   2. `emitBatch` → `emitInvoice` replays/returns existing CAEs (a second
 *      delivery never emits a second invoice);
 *   3. the `issued_invoices` unique indexes (`(cuit,ptoVta,cbteTipo,cbteNro)`
 *      AND `(invoice_id)`) are the physical guards (C3).
 *
 * `step.run` wraps the batch so its output is memoized across retries — a
 * retry after a mid-batch crash resumes the SAME batch, never re-emits.
 *
 * The production gateway is composed by `buildArcaGateway` (credentials +
 * network → homologación-gated); the job itself is not exercised offline.
 */

import { inngest } from "@/lib/inngest/client";
import { emitBatch } from "@/lib/emission/emission-service";
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
    const results = await step.run("emit-batch", () =>
      emitBatch(
        {
          db: getDb(),
          gateway: buildArcaGateway(getDb()),
          emissionsEnabled: readEmissionsEnabled(),
          delayMs: 1000,
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
