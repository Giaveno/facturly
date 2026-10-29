import { randomUUID } from "node:crypto";
import { acquireSeriesClaim, finishSeriesClaim, reconcileSeriesClaim, ownsSeriesClaim, seriesKey } from "./series-claim";
/**
 * Reserve/send/persist under a durable environment + CUIT + PV + type claim.
 * Fresh numbers are always validated ARCA ultimo+1. No speculative advance.
 * A rejected/uncertain reservation blocks its series, but not other series.
 * Existing reservations only consult: absence never grants automatic reissue.
 * Database transactions remain short; no transaction spans a network request.
 */

import { and, eq, inArray, isNull, max, or } from "drizzle-orm";
import {
  clients,
  emissionSeriesClaims,
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
import { isUniqueViolation } from "@/lib/db/errors";
import type {
  ArcaGateway,
  FECAEReq,
  IssueInvoiceResult,
} from "@/ports/arca-gateway";
import type { CbteTipo } from "@/domain/policy";
import { deriveAmounts } from "@/domain/amounts";
import { ANONYMOUS_IDENTIFICATION_THRESHOLD_CENTS } from "@/domain/receipt";
import { createApprovalSnapshot, matchesApprovalSnapshot } from "@/domain/approval-snapshot";
import { resolveArcaEnvironment } from "./environment";
import type { Db } from "@/lib/db/types";
import {
  ArcaAuthError,
  ArcaBusinessError,
  ArcaError,
  ArcaTransientError,
  safeEmissionError,
  type EmissionStage,
} from "@/adapters/arca/errors";
import { uncertainGraceMs, SERIES_BLOCKED_MESSAGE } from "./comprobante-emission-service";
import type { QueryCategory } from "@/adapters/arca/query-diagnostics";
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
  environment?: "production" | "homologacion";
  /** Inter-call delay in ms; injectable so tests never sleep. Default 0 in tests. */
  delayMs?: number;
  logger?: ArcaLogger;
  metrics?: ArcaMetrics;
  /** Operational/test override; production defaults to 3× the ARCA call budget. */
  uncertainGraceMs?: number;
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
  stage?: EmissionStage;
  category?: QueryCategory;
  providerCodes?: number[];
  httpStatus?: number;
}

/** Queries current ARCA state for each fresh reservation; never skips a local head. */
export class NumberAllocator {

  constructor(
    private readonly gateway: ArcaGateway,
    private readonly localMax?: (
      cuit: string,
      ptoVta: number,
      cbteTipo: CbteTipo,
    ) => Promise<number>,
  ) {}

  async next(cuit: string, ptoVta: number, cbteTipo: CbteTipo): Promise<number> {
    let arcaLast: number;
    try {
      arcaLast = await this.gateway.ultimoAutorizado(cuit, ptoVta, cbteTipo);
    } catch (err) {
      throw safeEmissionError(err, "ultimo");
    }
    if (!Number.isInteger(arcaLast) || arcaLast < 0 || arcaLast > 99_999_999) {
      throw new ArcaBusinessError("ARCA ultimo failed (malformed-response)", { stage: "ultimo", category: "malformed-response" });
    }
    const localLast = this.localMax
      ? await this.localMax(cuit, ptoVta, cbteTipo)
      : 0;
    if (localLast > arcaLast) throw new EmissionError("Local reserved number is ahead of ARCA; unresolved series requires consultation");
    if (arcaLast === 99_999_999) throw new EmissionError("Comprobante number range exhausted");
    return arcaLast + 1;
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
    taxRate: invoice.taxRate,
    importeTotal: invoice.importeTotalCentavos ?? 0,
  };
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
  environment: "production" | "homologacion",
): Promise<number> {
  const [row] = await db
    .select({ m: max(issuedInvoices.cbteNro) })
    .from(issuedInvoices)
    .where(
      and(
        or(eq(issuedInvoices.environment, environment), isNull(issuedInvoices.environment)),
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
    localMaxCbteNro(deps.db, cuit, ptoVta, cbteTipo, deps.environment ?? resolveArcaEnvironment(process.env)),
  );
}

/** A durable claim covers allocation, reservation, dispatch and persistence. */
export async function emitInvoice(deps: EmissionDeps, allocator: NumberAllocator, invoiceId: string): Promise<EmissionResult> {
  if (!deps.emissionsEnabled) throw new EmissionError("Emissions are disabled; refusing to reserve a number");
  const { client, invoice } = await loadInvoiceContext(deps.db, invoiceId);
  const [existing] = await deps.db.select().from(issuedInvoices).where(eq(issuedInvoices.invoiceId,invoiceId));
  // Recovery is read-only on ARCA: never call FECAESolicitar for a reservation.
  if (existing) {
    const key = seriesKey(deps.environment ?? resolveArcaEnvironment(process.env),client.cuit,client.ptoVta,invoice.cbteTipo ?? 0);
    const [claim] = await deps.db.select().from(emissionSeriesClaims).where(eq(emissionSeriesClaims.seriesKey,key));
    if (!existing.cae && claim?.owner && claim.leaseExpiresAtMs > Date.now()) throw new EmissionError("Series is actively dispatching; consultation/recovery must wait");
    if (!existing.cae && claim?.uncertain && !claim.owner) {
      const uncertainAt = claim.uncertainSinceMs ?? claim.leaseExpiresAtMs;
      const environment = deps.environment ?? resolveArcaEnvironment(process.env);
      if (Date.now() - uncertainAt < (deps.uncertainGraceMs ?? uncertainGraceMs(environment, process.env))) throw new EmissionError(SERIES_BLOCKED_MESSAGE);
    }
    const recovered = await emitWithSeriesClaim(deps,allocator,invoiceId,undefined,
      claim && !existing.cae ? async tx => { await reconcileSeriesClaim(tx,claim); } : undefined);
    return recovered;
  }
  const environment = deps.environment ?? resolveArcaEnvironment(process.env);
  const key = seriesKey(environment,client.cuit,client.ptoVta,invoice.cbteTipo ?? 0), owner = randomUUID();
  if (!await acquireSeriesClaim(deps.db,key,owner)) throw new EmissionError("Series has an active or uncertain claim; consult first, never reissue");
  let authorized = false;
  try {
    const result = await emitWithSeriesClaim(deps,allocator,invoiceId,async()=>{
      if(!await ownsSeriesClaim(deps.db,key,owner))throw new EmissionError("Dispatch claim lost/expired; consult first, never reissue");
    }, async tx => { await finishSeriesClaim(tx,key,owner,true); });
    authorized = true;
    return result;
  } finally {
    // Before reservation, a failed guard did not dispatch; safely release that claim.
    const [reserved] = await deps.db.select({id:issuedInvoices.id}).from(issuedInvoices).where(eq(issuedInvoices.invoiceId,invoiceId));
    await finishSeriesClaim(deps.db,key,owner,authorized || !reserved);
  }
}

/** Emits a single invoice (reserve → emit → persist), replaying a pinned number. */
async function emitWithSeriesClaim(
  deps: EmissionDeps,
  allocator: NumberAllocator,
  invoiceId: string,
  dispatchGuard?: () => Promise<void>,
  completeOwnedClaim?: (tx: Db) => Promise<void>,
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

  const environment = deps.environment ?? resolveArcaEnvironment(process.env);
  if (reservation && (reservation.environment !== environment || reservation.cuit !== client.cuit || reservation.ptoVta !== client.ptoVta || reservation.cbteTipo !== invoice.cbteTipo)) throw new EmissionError("Reservation provenance/series mismatch; manual read-only verification required");

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
  if (invoice.approvalSnapshot && !matchesApprovalSnapshot(invoice.approvalSnapshot,createApprovalSnapshot(row,client,deps.environment ?? resolveArcaEnvironment(process.env)))) {
    throw new EmissionError("Approval snapshot changed; refusing to reserve or emit");
  }

  const cbteTipo = invoice.cbteTipo;
  if (cbteTipo !== 1 && cbteTipo !== 6 && cbteTipo !== 11) {
    throw new EmissionError(
      `Invoice ${invoiceId} is not fully materialized (cbteTipo=${cbteTipo})`,
    );
  }
  if (invoice.receptorDocTipo === 99 && ((invoice.importeTotalCentavos ?? 0) >= ANONYMOUS_IDENTIFICATION_THRESHOLD_CENTS || invoice.receptorDocNro !== 0 || invoice.condicionIvaReceptorId !== 5)) {
    throw new EmissionError("Anonymous recipient identification policy requires manual remediation");
  }
  // Legacy taxable approvals without reviewed rate evidence must not reserve
  // a number or contact ARCA. Never guess A's old implicit 21% during recovery.
  if (cbteTipo === 1 || cbteTipo === 6) {
    if (invoice.taxRate === null) throw new EmissionError("Taxable IVA rate is missing; manual fiscal remediation is required before emission/recovery");
    const amounts = deriveAmounts(invoice.importeTotalCentavos ?? 0, cbteTipo, invoice.taxRate);
    if (amounts.net !== invoice.importeNetoCentavos || amounts.iva !== invoice.importeIvaCentavos) throw new EmissionError("A/B requires reviewed taxable IVA treatment before emission/recovery");
  }
  if (cbteTipo === 11 && (invoice.importeIvaCentavos !== 0 || invoice.importeNetoCentavos !== invoice.importeTotalCentavos)) {
    throw new EmissionError("Factura C cannot include IVA");
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

  if (!reservation) {
    const blockers = await db.select({id:issuedInvoices.id,environment:issuedInvoices.environment,cae:issuedInvoices.cae}).from(issuedInvoices).where(and(eq(issuedInvoices.cuit,client.cuit),eq(issuedInvoices.ptoVta,client.ptoVta),eq(issuedInvoices.cbteTipo,cbteTipo),or(eq(issuedInvoices.environment,environment),isNull(issuedInvoices.environment))));
    if (blockers.some(r => !r.environment || !r.cae)) throw new EmissionError("Unresolved reserved series head blocks fresh issuance; consult first");
  }
  const wasReserved = !!reservation;
  let cbteNro: number;
  if (reservation) {
    // Consultation only: preserve the pinned tuple, never send it again.
    cbteNro = reservation.cbteNro;
  } else {
    cbteNro = await allocator.next(client.cuit, client.ptoVta, cbteTipo);
    // Reserve in ONE transaction BEFORE contacting ARCA. The unique indexes are
    // the physical guard against a concurrent duplicate emission.
    try {
      await db.transaction(async (tx) => {
        await tx.insert(issuedInvoices).values({
          invoiceId,
          environment,
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
    const request = buildFecaReq(invoice,client,cbteNro);
    if (wasReserved) {
      if (!gateway.consultInvoice) throw new EmissionError("Reservation requires read-only consultation; reissue prohibited");
      const existing = await gateway.consultInvoice(request);
      if (!existing) throw new EmissionError("Reserved outcome unresolved; no automatic reissue");
      result = existing;
    } else {
      if(!dispatchGuard)throw new EmissionError("Dispatch claim is required");
      await dispatchGuard();
      // The legacy path shares the durable claim but must also revalidate the
      // remote head immediately before FECAESolicitar. If ARCA has advanced
      // beyond the pinned number, consult it and never reissue that number.
      let latest: number;
      try { latest = await gateway.ultimoAutorizado(request.cuit, request.ptoVta, request.cbteTipo); }
      catch { throw new ArcaTransientError("Unable to revalidate ARCA series head", { stage: "ultimo" }); }
      if (!Number.isInteger(latest) || latest < 0 || latest > 99_999_999) throw new ArcaTransientError("ARCA series head was malformed", { stage: "ultimo", category: "malformed-response" });
      if (latest >= request.cbteNro) {
        if (!gateway.consultInvoice) throw new ArcaTransientError("Pinned reservation requires read-only consultation", { stage: "issuance" });
        const observed = await gateway.consultInvoice(request);
        if (!observed) throw new ArcaTransientError("Pinned reservation remains unresolved", { stage: "issuance" });
        result = observed;
      } else {
        result = await gateway.issueInvoice(request, dispatchGuard);
      }
    }
  } catch (rawError) {
    const err = rawError instanceof EmissionError ? rawError : safeEmissionError(rawError, "issuance");
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
    // This callback is bound to this dispatch's unique owner and reservation.
    // CAE persistence and release commit together, before fallible audit/log work.
    await completeOwnedClaim?.(tx as unknown as Db);
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
  const safe = err instanceof ArcaError ? safeEmissionError(err, err.stage ?? "issuance") : undefined;
  return {
    invoiceId: id,
    outcome,
    error: safe?.message ?? (err instanceof EmissionError || err instanceof RowNotEmittableError || err instanceof InvoiceStateError ? err.message : "Emission failed (internal)"),
    arcaCode: safe?.code,
    stage: safe?.stage,
    category: safe?.category,
    providerCodes: safe?.providerCodes,
    httpStatus: safe?.httpStatus,
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

/** Recovery consults each pinned reservation; it never sends FECAESolicitar. */
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
