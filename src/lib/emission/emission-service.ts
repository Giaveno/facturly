/**
 * Emission service — the reserve→emit→persist pipeline (slice 4).
 *
 * Per invoice row, in order:
 *   1. Enforce `EMISSIONS_ENABLED` (a paused system must not even reserve numbers).
 *   2. WIRE the domain guard `assertRowEmittable` (BLOCKED/REJECTED/PENDING/FAILED
 *      rows can never be emitted) — the review UI's disabled button is a hint,
 *      this call is the enforcement.
 *   3. Enforce the invoice status machine: only APPROVED invoices emit fresh;
 *      EMITTING/EMIT_ERROR replay a pinned reservation.
 *   4. Authorize: the client must have an ENABLED `delegations` row.
 *   5. Pin the comprobante number: an existing `issued_invoices` reservation
 *      replays its `cbteNro` (lost-response retry); otherwise the next number is
 *      allocated ONCE per `(cuit, ptoVta, cbteTipo)` per batch, seeded from
 *      `max(local cbteNro, ARCA ultimoAutorizado)` and incremented locally.
 *   6. In ONE transaction, insert the reservation row (NULL CAE) and set the
 *      invoice EMITTING — BEFORE calling ARCA. The unique index on
 *      `(cuit, ptoVta, cbteTipo, cbteNro)` AND `(invoice_id)` are the physical
 *      guards: one invoice has at most one reservation, and a number is never
 *      emitted twice.
 *   7. Call `ArcaGateway.issueInvoice` with the pinned number.
 *   8. Persist the 14-digit CAE on the SAME reservation row and set EMITTED.
 *   9. On failure, classify permanent vs transient (typed ARCA errors):
 *        - permanent (ARCA business rejection / state error) → EMIT_FAILED
 *          (terminal; the recovery sweeper NEVER re-queues it);
 *        - transient (network/timeout/auth) → EMIT_ERROR (recoverable).
 *
 * Batches emit SERIALLY with an injectable inter-call delay and are PER-ROW
 * ISOLATED: one failure is recorded and the batch continues.
 */

import { and, eq, inArray, isNull, max } from "drizzle-orm";
import {
  clients,
  delegations,
  invoices,
  issuedInvoices,
  type invoices as InvoicesTable,
} from "@/lib/db/schema";
import {
  assertRowEmittable,
  RowNotEmittableError,
} from "@/domain/emission";
import { InvoiceStateError, loadInvoiceContext } from "@/lib/review/workflow";
import { writeAudit } from "@/lib/audit/audit";
import type {
  ArcaGateway,
  FECAEReq,
  IssueInvoiceResult,
} from "@/ports/arca-gateway";
import type { CbteTipo } from "@/domain/policy";
import type { Db } from "@/lib/db/types";
import {
  ArcaAuthError,
  ArcaBusinessError,
  ArcaError,
  ArcaTransientError,
} from "@/adapters/arca/errors";
import {
  noopLogger,
  noopMetrics,
  type ArcaLogger,
  type ArcaMetrics,
} from "@/adapters/arca/logger";

/** A failure in the emission pipeline (state machine, authorization, etc.). */
export class EmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmissionError";
  }
}

/** A reservation insert collided with the unique (invoice_id) or number index. */
export class ReservationCollisionError extends EmissionError {
  readonly cbteNro: number;

  constructor(invoiceId: string, cbteNro: number) {
    super(
      `Reservation collision for invoice ${invoiceId} at cbteNro ${cbteNro} — another reservation already holds this number or invoice`,
    );
    this.name = "ReservationCollisionError";
    this.cbteNro = cbteNro;
  }
}

export interface EmissionDeps {
  db: Db;
  gateway: ArcaGateway;
  /** Master kill switch (job reads EMISSIONS_ENABLED). Default false — safe. */
  emissionsEnabled: boolean;
  /** Inter-call delay in ms; injectable so tests never sleep. Default 0 in tests. */
  delayMs?: number;
  logger?: ArcaLogger;
  metrics?: ArcaMetrics;
}

export interface EmissionResult {
  invoiceId: string;
  cbteNro: number;
  cae: string;
  /** False when the invoice was already emitted (idempotent replay, no-op). */
  emitted: boolean;
}

/** Per-row outcome of a batch / recovery run (never throws on a single row). */
export type EmissionOutcome =
  | "emitted"
  | "already_emitted"
  | "failed_transient"
  | "failed_permanent"
  | "failed_collision";

export interface EmissionBatchResult {
  invoiceId: string;
  outcome: EmissionOutcome;
  cbteNro?: number;
  cae?: string;
  error?: string;
  arcaCode?: string;
}

/**
 * Allocates comprobante numbers ONCE per key, seeded from
 * `max(local cbteNro, ARCA ultimoAutorizado)` so a stale local reservation
 * (crash after commit, before ARCA) is never re-allocated to a later invoice.
 */
export class NumberAllocator {
  private readonly last = new Map<string, number>();

  constructor(
    private readonly gateway: ArcaGateway,
    private readonly localMax?: (
      cuit: string,
      ptoVta: number,
      cbteTipo: CbteTipo,
    ) => Promise<number>,
  ) {}

  async next(cuit: string, ptoVta: number, cbteTipo: CbteTipo): Promise<number> {
    const key = `${cuit}:${ptoVta}:${cbteTipo}`;
    const current = this.last.get(key);
    if (current !== undefined) {
      const next = current + 1;
      this.last.set(key, next);
      return next;
    }
    // First number for this key: seed from BOTH ARCA and our local max, then
    // increment locally (W3 — a stale reservation must not be re-allocated).
    const arcaLast = await this.gateway.ultimoAutorizado(cuit, ptoVta, cbteTipo);
    const localLast = this.localMax
      ? await this.localMax(cuit, ptoVta, cbteTipo)
      : 0;
    const next = Math.max(arcaLast, localLast) + 1;
    this.last.set(key, next);
    return next;
  }
}

/** Builds the `FECAEReq` from a fully-materialized (APPROVED) invoice + client. */
export function buildFecaReq(
  invoice: typeof InvoicesTable.$inferSelect,
  client: typeof clients.$inferSelect,
  cbteNro: number,
): FECAEReq {
  return {
    cuit: client.cuit,
    ptoVta: client.ptoVta,
    cbteTipo: invoice.cbteTipo as CbteTipo,
    cbteNro,
    receptorDocTipo: invoice.receptorDocTipo ?? 0,
    receptorDocNro: invoice.receptorDocNro ?? 0,
    condicionIvaReceptorId: invoice.condicionIvaReceptorId ?? 0,
    receptorRazonSocial: invoice.receptorRazonSocial ?? "",
    fechaEmision: invoice.fechaEmision ?? "",
    fechaVto: invoice.fechaVto ?? "",
    moneda: invoice.moneda ?? "PES",
    cotizacion: invoice.cotizacion ?? 1,
    importeNeto: invoice.importeNetoCentavos ?? 0,
    importeIva: invoice.importeIvaCentavos ?? 0,
    importeTotal: invoice.importeTotalCentavos ?? 0,
  };
}

/** Detects a Postgres/PGlite unique-violation (code 23505), walking the error
 * `.cause` chain — Drizzle wraps the driver error in `DrizzleQueryError`, which
 * carries the real `code`/`message` under `.cause`. */
function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  while (e && typeof e === "object") {
    const obj = e as { code?: string; message?: string; cause?: unknown };
    if (obj.code === "23505") return true;
    const msg = obj.message ?? "";
    if (/duplicate key value|unique constraint|unique_violation/i.test(msg)) {
      return true;
    }
    e = obj.cause;
  }
  return false;
}

/**
 * Classifies a failure as permanent (do NOT retry) or transient (retryable).
 * ARCA business rejections and local state/config errors are permanent; ARCA
 * transient/auth errors are retryable.
 */
function isPermanentFailure(err: unknown): boolean {
  if (err instanceof ArcaBusinessError) return true;
  if (err instanceof ArcaTransientError) return false;
  if (err instanceof ArcaAuthError) return false;
  if (err instanceof RowNotEmittableError) return true;
  if (err instanceof InvoiceStateError) return true;
  if (err instanceof EmissionError) return true;
  return false; // unknown → transient (safe to retry)
}

/** The highest locally-reserved `cbteNro` for a key (0 when none). */
async function localMaxCbteNro(
  db: Db,
  cuit: string,
  ptoVta: number,
  cbteTipo: CbteTipo,
): Promise<number> {
  const [row] = await db
    .select({ m: max(issuedInvoices.cbteNro) })
    .from(issuedInvoices)
    .where(
      and(
        eq(issuedInvoices.cuit, cuit),
        eq(issuedInvoices.ptoVta, ptoVta),
        eq(issuedInvoices.cbteTipo, cbteTipo),
      ),
    );
  const m = row?.m;
  return typeof m === "number" ? m : 0;
}

function makeAllocator(deps: EmissionDeps): NumberAllocator {
  return new NumberAllocator(deps.gateway, (cuit, ptoVta, cbteTipo) =>
    localMaxCbteNro(deps.db, cuit, ptoVta, cbteTipo),
  );
}

/** Emits a single invoice (reserve → emit → persist), replaying a pinned number. */
export async function emitInvoice(
  deps: EmissionDeps,
  allocator: NumberAllocator,
  invoiceId: string,
): Promise<EmissionResult> {
  const { db, gateway } = deps;
  const logger = deps.logger ?? noopLogger;
  const metrics = deps.metrics ?? noopMetrics;
  if (!deps.emissionsEnabled) {
    throw new EmissionError(
      "Emissions are disabled (EMISSIONS_ENABLED=false) — refusing to reserve a number",
    );
  }

  const { invoice, row, client } = await loadInvoiceContext(db, invoiceId);

  // Idempotency (checked FIRST): an already-persisted CAE means the invoice was
  // emitted — return it as a no-op before any further guard can re-emit.
  let [reservation] = await db
    .select()
    .from(issuedInvoices)
    .where(eq(issuedInvoices.invoiceId, invoiceId));

  if (reservation?.cae) {
    return {
      invoiceId,
      cbteNro: reservation.cbteNro,
      cae: reservation.cae,
      emitted: false,
    };
  }

  // 4.B — the WIRED guard: a BLOCKED / REJECTED / PENDING / FAILED row can
  // never emit.
  assertRowEmittable(row.status);

  // Status machine: fresh emits are APPROVED; retries replay from EMITTING or
  // EMIT_ERROR (a reservation already pins the number). EMIT_FAILED (permanent)
  // and everything else refuses.
  const emittable =
    invoice.status === "APPROVED" ||
    invoice.status === "EMITTING" ||
    invoice.status === "EMIT_ERROR";
  if (!emittable) {
    throw new EmissionError(
      `Invoice ${invoiceId} has status "${invoice.status}" — not emittable`,
    );
  }

  const cbteTipo = invoice.cbteTipo;
  if (cbteTipo !== 1 && cbteTipo !== 6 && cbteTipo !== 11) {
    throw new EmissionError(
      `Invoice ${invoiceId} is not fully materialized (cbteTipo=${cbteTipo})`,
    );
  }

  // 4.D — per-client delegation authorization.
  const delegation = await db
    .select()
    .from(delegations)
    .where(eq(delegations.clientId, client.id));
  const authorized = delegation.some((d) => d.enabled);
  if (!authorized) {
    throw new EmissionError(
      `Client ${client.razonSocial} (${client.cuit}) has no enabled wsfe delegation — refusing to emit`,
    );
  }

  let cbteNro: number;
  if (reservation) {
    // Lost-response retry: replay the PINNED number, never re-derive it.
    cbteNro = reservation.cbteNro;
  } else {
    cbteNro = await allocator.next(client.cuit, client.ptoVta, cbteTipo);
    // Reserve in ONE transaction BEFORE contacting ARCA. The unique indexes are
    // the physical guard against a concurrent duplicate emission.
    try {
      await db.transaction(async (tx) => {
        await tx.insert(issuedInvoices).values({
          invoiceId,
          cuit: client.cuit,
          ptoVta: client.ptoVta,
          cbteTipo,
          cbteNro,
          cae: null,
          caeFchVto: null,
          importeTotalCentavos: invoice.importeTotalCentavos ?? 0,
        });
        await tx
          .update(invoices)
          .set({ status: "EMITTING" })
          .where(eq(invoices.id, invoiceId));
      });
    } catch (err) {
      // W3: a reservation collision must not surface as a raw DB error.
      if (isUniqueViolation(err)) {
        throw new ReservationCollisionError(invoiceId, cbteNro);
      }
      throw err;
    }
    [reservation] = await db
      .select()
      .from(issuedInvoices)
      .where(eq(issuedInvoices.invoiceId, invoiceId));
  }

  // Observability + audit: the attempt itself is a fiscal action.
  metrics.increment("emission_attempt");
  await writeAudit(db, {
    actor: "system",
    action: "emission.attempt",
    invoiceId,
    payload: {
      cuit: client.cuit,
      cbteNro,
      cbteTipo,
      ptoVta: client.ptoVta,
    },
  });
  const started = Date.now();

  let result: IssueInvoiceResult;
  try {
    result = await gateway.issueInvoice(buildFecaReq(invoice, client, cbteNro));
  } catch (err) {
    const duration = Date.now() - started;
    const permanent = isPermanentFailure(err);
    const code = err instanceof ArcaError ? err.code : undefined;
    logger.error("emission_failed", {
      invoiceId,
      cuit: client.cuit,
      cbteNro,
      code,
      duration_ms: duration,
      kind: permanent ? "permanent" : "transient",
    });
    metrics.increment("emission_failed");
    await writeAudit(db, {
      actor: "system",
      action: "emission.error",
      invoiceId,
      payload: {
        cuit: client.cuit,
        cbteNro,
        code,
        kind: permanent ? "permanent" : "transient",
        message: err instanceof Error ? err.message : String(err),
      },
    });
    // Permanent → terminal EMIT_FAILED (never re-queued); transient → EMIT_ERROR
    // (recoverable). The reservation stays (never deleted) so the number is pinned.
    await db
      .update(invoices)
      .set({
        status: permanent ? "EMIT_FAILED" : "EMIT_ERROR",
        discardReason:
          permanent && err instanceof Error ? err.message : null,
      })
      .where(eq(invoices.id, invoiceId));
    throw err;
  }

  // Persist the CAE on the SAME reservation row and mark EMITTED.
  await db.transaction(async (tx) => {
    await tx
      .update(issuedInvoices)
      .set({ cae: result.cae, caeFchVto: result.caeFchVto })
      .where(eq(issuedInvoices.id, reservation!.id));
    await tx
      .update(invoices)
      .set({ status: "EMITTED" })
      .where(eq(invoices.id, invoiceId));
  });

  const duration = Date.now() - started;
  logger.info("emission_succeeded", {
    invoiceId,
    cuit: client.cuit,
    cbteNro,
    cae: result.cae,
    duration_ms: duration,
  });
  metrics.increment("emission_succeeded");
  await writeAudit(db, {
    actor: "system",
    action: "emission.cae_persisted",
    invoiceId,
    payload: {
      cuit: client.cuit,
      cbteNro,
      cae: result.cae,
      caeFchVto: result.caeFchVto,
    },
  });

  return { invoiceId, cbteNro, cae: result.cae, emitted: true };
}

/** Lists APPROVED invoice ids (the emission batch), oldest first. */
export async function listApprovedInvoiceIds(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(eq(invoices.status, "APPROVED"));
  return rows.map((r) => r.id);
}

/**
 * Lists invoices stuck in EMITTING/EMIT_ERROR with a NULL-CAE reservation — the
 * rows the recovery sweeper must replay (C2: a CAE authorized at ARCA but never
 * persisted locally is otherwise lost forever).
 */
export async function listRecoverableInvoiceIds(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: invoices.id })
    .from(invoices)
    .innerJoin(issuedInvoices, eq(invoices.id, issuedInvoices.invoiceId))
    .where(
      and(
        inArray(invoices.status, ["EMITTING", "EMIT_ERROR"]),
        isNull(issuedInvoices.cae),
      ),
    );
  return rows.map((r) => r.id);
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function outcomeOf(
  r: EmissionResult,
): EmissionBatchResult {
  return {
    invoiceId: r.invoiceId,
    outcome: r.emitted ? "emitted" : "already_emitted",
    cbteNro: r.cbteNro,
    cae: r.cae,
  };
}

function failureOf(id: string, err: unknown): EmissionBatchResult {
  const outcome =
    err instanceof ReservationCollisionError
      ? "failed_collision"
      : isPermanentFailure(err)
        ? "failed_permanent"
        : "failed_transient";
  return {
    invoiceId: id,
    outcome,
    error: err instanceof Error ? err.message : String(err),
    arcaCode: err instanceof ArcaError ? err.code : undefined,
  };
}

/** Emits a batch of APPROVED invoices SERIALLY, per-row isolated (W2). */
export async function emitBatch(
  deps: EmissionDeps,
  invoiceIds?: string[],
): Promise<EmissionBatchResult[]> {
  if (!deps.emissionsEnabled) {
    throw new EmissionError(
      "Emissions are disabled (EMISSIONS_ENABLED=false) — nothing will be reserved",
    );
  }
  const ids = invoiceIds ?? (await listApprovedInvoiceIds(deps.db));
  const allocator = makeAllocator(deps);
  const results: EmissionBatchResult[] = [];
  for (const id of ids) {
    try {
      results.push(outcomeOf(await emitInvoice(deps, allocator, id)));
    } catch (err) {
      results.push(failureOf(id, err));
    }
    const delay = deps.delayMs ?? 0;
    if (delay > 0) await sleep(delay);
  }
  return results;
}

/**
 * Recovery sweeper: replays every invoice stuck in EMITTING/EMIT_ERROR with a
 * NULL CAE, re-driving the pinned `cbteNro` so ARCA returns 10015/10016 and the
 * CAE is recovered via FECompConsultar — no second invoice (C2).
 */
export async function recoverStuckEmissions(
  deps: EmissionDeps,
): Promise<EmissionBatchResult[]> {
  if (!deps.emissionsEnabled) {
    throw new EmissionError(
      "Emissions are disabled (EMISSIONS_ENABLED=false) — nothing will be recovered",
    );
  }
  const ids = await listRecoverableInvoiceIds(deps.db);
  const allocator = makeAllocator(deps);
  const results: EmissionBatchResult[] = [];
  for (const id of ids) {
    try {
      results.push(outcomeOf(await emitInvoice(deps, allocator, id)));
    } catch (err) {
      results.push(failureOf(id, err));
    }
    const delay = deps.delayMs ?? 0;
    if (delay > 0) await sleep(delay);
  }
  return results;
}
