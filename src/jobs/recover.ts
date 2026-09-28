/**
 * Inngest recovery sweeper — THIN adapter over `recoverStuckEmissions`
 * (fully tested offline). Closes C2: an invoice that ARCA authorized but whose
 * CAE was never persisted (crash between the reservation commit and the CAE
 * write, or a lost response) stays in EMITTING/EMIT_ERROR with a NULL CAE
 * otherwise FOREVER. This scheduled function re-drives those rows on a cadence
 * so the lost CAE is recovered via `FECompConsultar`.
 *
 * Cadence: every 15 minutes (a 5-field cron). The emit job already handles the
 * happy path per-approval; this sweeper only replays STUCK rows. At ~100
 * invoices/month the failure volume is tiny, so 15 minutes keeps a lost CAE
 * recoverable promptly (~96 idempotent invocations/day) without a per-minute
 * cron bill. Each run is idempotent: `recoverStuckEmissions` no-ops on rows
 * that already have a CAE or are no longer stuck.
 *
 * `step.run` wraps the sweep so its output is memoized across retries.
 *
 * The production gateway is composed by `buildArcaGateway` (credentials +
 * network → homologación-gated); the job itself is not exercised offline (the
 * Inngest scheduler/event system is required).
 */

import { inngest } from "@/lib/inngest/client";
import { recoverStuckEmissions } from "@/lib/emission/emission-service";
import { buildArcaGateway } from "@/lib/emission/gateway";
import { readEmissionsEnabled } from "@/adapters/arca/emissions";
import { getDb } from "@/lib/db/client";

export const recoverStuckEmissionsJob = inngest.createFunction(
  {
    id: "emission/recover-stuck",
    triggers: [{ cron: "*/15 * * * *" }],
    retries: 3,
  },
  async ({ step }) => {
    const results = await step.run("recover-stuck", () =>
      recoverStuckEmissions({
        db: getDb(),
        gateway: buildArcaGateway(getDb()),
        emissionsEnabled: readEmissionsEnabled(),
        delayMs: 1000,
      }),
    );
    return { recovered: results.length };
  },
);
