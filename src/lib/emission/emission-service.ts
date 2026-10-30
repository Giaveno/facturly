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
import { assertEmissionConfiguration, EmissionDisabledError } from "@/adapters/arca/emissions";
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
  env?: Record<string, string | undefined>;
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

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

/** A consultation may only complete a pinned reservation with an exact number and valid CAE. */
function isValidPinnedResult(request: FECAEReq, result: IssueInvoiceResult | null): result is IssueInvoiceResult {
  return !!result &&
    result.cbteNro === request.cbteNro &&
    /^\d{14}$/.test(result.cae) &&
    isIsoDate(result.caeFchVto);
}

/** A durable claim covers allocation, reservation, dispatch and persistence. */
/** Retired: old callers cannot reserve or dispatch outside emitComprobante. */
export async function emitInvoice(_deps: EmissionDeps, _allocator: NumberAllocator, _invoiceId: string): Promise<EmissionResult> {
  throw new EmissionError("El camino anterior de emisión está deshabilitado; use emitComprobante.");
}

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
  if (deps.env) assertEmissionConfiguration(deps.env);
  if (!deps.emissionsEnabled) {
    throw new EmissionDisabledError();
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
export async function recoverStuckEmissions(deps: EmissionDeps): Promise<EmissionBatchResult[]> {
  if (!deps.emissionsEnabled) throw new EmissionDisabledError();
  const env = deps.env ?? process.env;
  assertEmissionConfiguration(env);
  const { recoverCanonicalSeries } = await import("./review-emission-service");
  return recoverCanonicalSeries({ db: deps.db, gateway: deps.gateway, env, environment: deps.environment, uncertainGraceMs: deps.uncertainGraceMs });
}
