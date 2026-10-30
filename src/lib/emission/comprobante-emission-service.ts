import { tracePhase, traceFailure, phaseFailure, emissionPhase, setTraceComprobante, withEmissionTrace } from "./trace";
import { fiscalDate } from "@/domain/fiscal-date";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { validateComprobante, type ComprobanteAmbiente, type ComprobanteItem, type ComprobanteValidationInput } from "@/domain/comprobantes";
import { sanitizeFaultText } from "@/adapters/arca/query-diagnostics";
import { ArcaError, ArcaBusinessError } from "@/adapters/arca/errors";
import { assertEmissionConfiguration, EmissionConfigurationError, EmissionDisabledError } from "@/adapters/arca/emissions";
import { comprobantes, clients, emissionSeriesClaims, issuedInvoices } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { ArcaGateway, FECAEReq, IssueInvoiceResult } from "@/ports/arca-gateway";
import { resolveArcaEnvironment } from "./environment";
import { acquireExpiredSeriesClaim, acquireSeriesClaim, finishSeriesClaim, ownsSeriesClaim, reconcileSeriesClaim, SERIES_LEASE_MS, seriesKey } from "./series-claim";
import { arcaTimeouts } from "@/adapters/arca/timeouts";
import { creditNoteTypeFor, isCreditNoteCbteTipo, type InvoiceCbteTipo } from "@/domain/policy";
type SeriesClaim = typeof emissionSeriesClaims.$inferSelect;

export const RECONCILIATION_NOT_FOUND_REASON = "ARCA no encontró el comprobante reservado; no se reemitirá automáticamente.";
export const RECONCILIATION_MISMATCH_REASON = "ARCA devolvió un comprobante con datos incompatibles; la serie sigue bloqueada y requiere verificación manual.";
export const RECONCILIATION_UNCERTAIN_REASON = "No se pudo confirmar el comprobante reservado en ARCA; requiere verificación manual.";
export const EMISSION_UNCERTAIN_REASON = "El resultado de ARCA es incierto después de reservar el número; requiere verificación manual.";
export const IDEMPOTENCY_CONFLICT_REASON = "La clave de idempotencia ya pertenece a otro emisor o serie fiscal.";
export const SERIES_BLOCKED_MESSAGE = "serie bloqueada, pendiente de conciliación";
export const LEGACY_SERIES_RECOVERY_REQUIRED = "La serie contiene una reserva legacy pendiente; use la recuperación legacy de emisión antes de liberar el bloqueo.";

export class ComprobanteEmissionError extends Error {
  constructor(message: string) { super(message); this.name = "ComprobanteEmissionError"; }
}
export { EmissionConfigurationError, EmissionDisabledError };

export interface ComprobanteEmissionInput extends Omit<ComprobanteValidationInput, "ambiente" | "estado" | "cae" | "caeVto"> {
  empresaId: string;
  idempotencyKey: string;
  /** When present, emit a credit note against this approved invoice. */
  comprobanteAsociadoId?: string;
}
export interface ComprobanteEmissionDeps {
  db: Db;
  gateway: ArcaGateway;
  environment?: ComprobanteAmbiente | "production";
  now?: () => Date;
  /** Test/observability seam after the durable reservation, before FECAESolicitar. */
  beforeArca?: () => Promise<void>;
  /** Override for tests/operations; production defaults to at least ten minutes. */
  uncertainGraceMs?: number;
  env?: Record<string, string | undefined>;
}
export interface ComprobanteEmissionResult {
  id: string;
  empresaId: string;
  estado: "aprobado" | "rechazado" | "incierto";
  cbteNro: number | null;
  cae: string | null;
  caeVto: string | null;
  resultado: string | null;
  errores: string | null;
  emitted: boolean;
}

const DAY_MS = 86_400_000;
const CLAIM_WAIT_MS = 10;
const CLAIM_WAIT_ATTEMPTS = Math.ceil(SERIES_LEASE_MS / CLAIM_WAIT_MS);
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }


/** ARCA permits a comprobante date no more than five calendar days in the past. */
export function assertArcaDateWindow(fecha: string, now = new Date()): void {
  const today = Date.parse(`${fiscalDate(now)}T00:00:00Z`);
  const issued = Date.parse(`${fecha}T00:00:00Z`);
  if (!Number.isFinite(issued) || issued > today || today - issued > 5 * DAY_MS) {
    throw new ComprobanteEmissionError("La fecha del comprobante debe estar dentro de la ventana de 5 días calendario de ARCA.");
  }
}
async function withSeriesLock<T>(db: Db, key: string, work: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    return work(tx as unknown as Db);
  });
}
async function claimFor(db: Db, key: string): Promise<SeriesClaim | undefined> {
  return withSeriesLock(db, key, async (tx) => {
    const [claim] = await tx.select().from(emissionSeriesClaims).where(eq(emissionSeriesClaims.seriesKey, key));
    return claim;
  });
}
async function releaseClaim(db: Db, key: string, owner: string, authorized: boolean, timestamp = Date.now()): Promise<void> {
  await withSeriesLock(db, key, async (tx) => finishSeriesClaim(tx, key, owner, authorized, timestamp));
}
async function clearUncertainClaim(db: Db, key: string, observed: SeriesClaim): Promise<void> {
  await withSeriesLock(db, key, async (tx) => {
    await tx.update(emissionSeriesClaims).set({ uncertain: false, uncertainSinceMs: null }).where(and(
      eq(emissionSeriesClaims.seriesKey, key), isNull(emissionSeriesClaims.owner), eq(emissionSeriesClaims.uncertain, true),
      eq(emissionSeriesClaims.leaseExpiresAtMs, observed.leaseExpiresAtMs),
      observed.uncertainSinceMs === null ? isNull(emissionSeriesClaims.uncertainSinceMs) : eq(emissionSeriesClaims.uncertainSinceMs, observed.uncertainSinceMs),
    ));
  });
}
async function waitForNoOwner(db: Db, key: string): Promise<void> {
  for (let attempt = 0; attempt < CLAIM_WAIT_ATTEMPTS; attempt += 1) {
    if (!(await claimFor(db, key))?.owner) return;
    await sleep(CLAIM_WAIT_MS);
  }
  throw new ComprobanteEmissionError(RECONCILIATION_UNCERTAIN_REASON);
}
async function claimSeries(db: Db, key: string, owner: string): Promise<void> {
  for (let attempt = 0; attempt < CLAIM_WAIT_ATTEMPTS; attempt += 1) {
    const claim = await claimFor(db, key);
    if (claim?.uncertain && !claim.owner) throw new ComprobanteEmissionError(SERIES_BLOCKED_MESSAGE);
    if (!claim?.owner || claim.owner === owner) {
      if (await withSeriesLock(db, key, async (tx) => acquireSeriesClaim(tx, key, owner))) return;
    }
    await sleep(CLAIM_WAIT_MS);
  }
  throw new ComprobanteEmissionError(RECONCILIATION_UNCERTAIN_REASON);
}
export function uncertainGraceMs(environment: ComprobanteAmbiente | "production", env: Record<string, string | undefined> = process.env): number {
  const configured = Number(env.ARCA_UNCERTAIN_GRACE_MS);
  if (Number.isSafeInteger(configured) && configured >= 0) return configured;
  const arcaEnvironment = environment === "produccion" ? "production" : environment;
  const callBudgetGrace = 3 * arcaTimeouts(arcaEnvironment).callMs;
  return arcaEnvironment === "production" ? Math.max(10 * 60_000, callBudgetGrace) : callBudgetGrace;
}
function taxRate(items: ComprobanteItem[]): number | null { return items.find((item) => item.alicuota !== 0)?.alicuota ?? 0; }

type CreditNoteAssociation = { tipo: InvoiceCbteTipo; ptoVta: number; nro: number };

/** Pure mapping from a persisted comprobante row to its WSFE request. */
function fecaAssociation(original: CreditNoteAssociation | undefined): Array<{ tipo: number; ptoVta: number; nro: number }> | undefined {
  return original ? [{ tipo: original.tipo, ptoVta: original.ptoVta, nro: original.nro }] : undefined;
}

async function validateCreditNote(
  db: Db,
  input: ComprobanteEmissionInput,
  validated: ComprobanteValidationInput & { emisorCondicionIva: NonNullable<ComprobanteValidationInput["emisorCondicionIva"]> },
): Promise<CreditNoteAssociation | undefined> {
  if (!input.comprobanteAsociadoId) {
    if (isCreditNoteCbteTipo(validated.cbteTipo)) throw new ComprobanteEmissionError("La nota de crédito requiere un comprobante original aprobado.");
    return undefined;
  }
  if (!isCreditNoteCbteTipo(validated.cbteTipo)) throw new ComprobanteEmissionError("El comprobante asociado solo puede usarse en una nota de crédito.");
  const [original] = await db.select().from(comprobantes).where(eq(comprobantes.id, input.comprobanteAsociadoId));
  if (!original || original.estado !== "aprobado" || original.cae == null || original.caeVto == null || original.cbteNro == null) {
    throw new ComprobanteEmissionError("El comprobante original debe estar aprobado por ARCA.");
  }
  if (original.empresaId !== input.empresaId || original.emisorCuit !== validated.emisorCuit) {
    throw new ComprobanteEmissionError("El comprobante original pertenece a otra empresa o emisor.");
  }
  if (original.ambiente !== validated.ambiente || original.ptoVta !== validated.ptoVta) {
    throw new ComprobanteEmissionError("El comprobante original no pertenece al mismo ambiente o punto de venta.");
  }
  if (original.docTipo !== validated.docTipo || original.docNro !== validated.docNro || original.condicionIvaReceptor !== validated.condicionIvaReceptor) {
    throw new ComprobanteEmissionError("La nota de crédito debe conservar el receptor del comprobante original.");
  }
  if (original.cbteTipo !== 1 && original.cbteTipo !== 6 && original.cbteTipo !== 11) {
    throw new ComprobanteEmissionError("El comprobante asociado debe ser una factura válida.");
  }
  const expectedType = creditNoteTypeFor(original.cbteTipo as InvoiceCbteTipo);
  if (validated.cbteTipo !== expectedType) {
    throw new ComprobanteEmissionError(`El tipo de nota de crédito no coincide con el comprobante original (se esperaba ${expectedType}).`);
  }
  const approvedNotes = await db.select({ total: comprobantes.importeTotalCentavos }).from(comprobantes).where(and(
    eq(comprobantes.comprobanteAsociadoId, original.id), eq(comprobantes.estado, "aprobado"),
  ));
  const cumulative = approvedNotes.reduce((sum, note) => sum + (note.total ?? 0), 0);
  if (cumulative + validated.importeTotalCentavos > original.importeTotalCentavos) {
    throw new ComprobanteEmissionError("El total acumulado de notas de crédito supera el comprobante original.");
  }
  return { tipo: original.cbteTipo as InvoiceCbteTipo, ptoVta: original.ptoVta, nro: original.cbteNro };
}

export function comprobanteToFecaReq(row: typeof comprobantes.$inferSelect, original?: CreditNoteAssociation): FECAEReq {
  const docNro = Number(row.docNro);
  if (!Number.isSafeInteger(docNro)) throw new ComprobanteEmissionError("DocNro excede el rango admitido por WSFE.");
  return {
    cuit: row.emisorCuit, ptoVta: row.ptoVta, cbteTipo: row.cbteTipo as 1 | 6 | 11, cbteNro: row.cbteNro!,
    receptorDocTipo: row.docTipo, receptorDocNro: docNro, condicionIvaReceptorId: row.condicionIvaReceptor,
    receptorRazonSocial: "", fechaEmision: row.fecha, fechaVto: row.fecha, moneda: "PES", cotizacion: 1,
    importeNeto: row.importeNetoCentavos, importeIva: row.importeIvaCentavos, importeTotal: row.importeTotalCentavos,
    taxRate: taxRate((row.items ?? []) as ComprobanteItem[]),
    cbtesAsoc: fecaAssociation(original),
  };
}
export function emissionFailureCause(error: unknown): string {
  const typed = error instanceof ArcaError ? error : undefined;
  const message = sanitizeFaultText(error instanceof Error ? error.message : "Error desconocido");
  const category: Record<string, string> = { timeout: "tiempo de espera agotado", network: "error de red", "malformed-response": "respuesta ilegible", internal: "error interno", "soap-fault": "fallo SOAP", http: "error HTTP" };
  const codes = typed?.providerCodes?.join(", ") || typed?.code;
  return [typed?.category ? category[typed.category] ?? typed.category : undefined, message, codes ? `código ${codes}` : undefined].filter(Boolean).join(": ");
}
function rejectionReason(error: ArcaBusinessError): string { return `Rechazo ARCA${error.code ? ` (${error.code})` : ""}: ${error.message}`; }
function isMatchingResult(row: typeof comprobantes.$inferSelect, result: IssueInvoiceResult): boolean {
  const evidence = result as IssueInvoiceResult & { importeTotalCentavos?: number; importeNetoCentavos?: number; importeIvaCentavos?: number };
  return result.cbteNro === row.cbteNro &&
    (evidence.importeTotalCentavos == null || evidence.importeTotalCentavos === row.importeTotalCentavos) &&
    (evidence.importeNetoCentavos == null || evidence.importeNetoCentavos === row.importeNetoCentavos) &&
    (evidence.importeIvaCentavos == null || evidence.importeIvaCentavos === row.importeIvaCentavos);
}
function isDefinitiveRejection(error: unknown): error is ArcaBusinessError {
  return error instanceof ArcaBusinessError && error.category !== "malformed-response" && error.category !== "http";
}
async function readByIdempotency(db: Db, empresaId: string, key: string) {
  const [row] = await db.select().from(comprobantes).where(and(eq(comprobantes.empresaId, empresaId), eq(comprobantes.idempotencyKey, key)));
  return row;
}
async function associationForRow(db: Db, row: typeof comprobantes.$inferSelect): Promise<CreditNoteAssociation | undefined> {
  if (!row.comprobanteAsociadoId) return undefined;
  const [original] = await db.select({ tipo: comprobantes.cbteTipo, ptoVta: comprobantes.ptoVta, nro: comprobantes.cbteNro })
    .from(comprobantes).where(eq(comprobantes.id, row.comprobanteAsociadoId));
  if (!original || original.nro == null) return undefined;
  return { tipo: original.tipo as InvoiceCbteTipo, ptoVta: original.ptoVta, nro: original.nro };
}
async function readOrphans(db: Db, key: string, environment: ComprobanteAmbiente, emisorCuit: string, ptoVta: number, cbteTipo: number) {
  return withSeriesLock(db, key, async (tx) => tx.select().from(comprobantes).where(and(
    eq(comprobantes.ambiente, environment), eq(comprobantes.emisorCuit, emisorCuit), eq(comprobantes.ptoVta, ptoVta),
    eq(comprobantes.cbteTipo, cbteTipo), inArray(comprobantes.estado, ["pendiente", "incierto"]),
  )));
}
async function updateOrphan(db: Db, key: string, id: string, patch: Partial<typeof comprobantes.$inferInsert>): Promise<void> {
  await withSeriesLock(db, key, async (tx) => {
    await tx.update(comprobantes).set({ ...patch, updatedAt: new Date() }).where(and(eq(comprobantes.id, id), inArray(comprobantes.estado, ["pendiente", "incierto"])));
  });
}
/** Each orphan outcome commits independently; a later consult failure cannot undo prior outcomes. */
async function reconcileOrphans(db: Db, deps: ComprobanteEmissionDeps, key: string, environment: ComprobanteAmbiente, emisorCuit: string, ptoVta: number, cbteTipo: number, onlyId?: string): Promise<void> {
  const allOrphans = await readOrphans(db, key, environment, emisorCuit, ptoVta, cbteTipo);
  const orphans = onlyId ? allOrphans.filter(row => row.id === onlyId) : allOrphans;
  for (const row of orphans) {
    if (row.cbteNro == null || !deps.gateway.consultInvoice) {
      await updateOrphan(db, key, row.id, { estado: "incierto", errores: phaseFailure(RECONCILIATION_UNCERTAIN_REASON, "reconciliation") });
      throw new ComprobanteEmissionError(RECONCILIATION_UNCERTAIN_REASON);
    }
    try {
      const result = await deps.gateway.consultInvoice(comprobanteToFecaReq(row, await associationForRow(db, row)));
      if (!result) await updateOrphan(db, key, row.id, { estado: "rechazado", resultado: "N", errores: phaseFailure(RECONCILIATION_NOT_FOUND_REASON, "reconciliation") });
      else if (!isMatchingResult(row, result)) {
        await updateOrphan(db, key, row.id, { estado: "incierto", errores: phaseFailure(RECONCILIATION_MISMATCH_REASON, "reconciliation") });
        throw new ComprobanteEmissionError(RECONCILIATION_MISMATCH_REASON);
      }
      else if (!result.cae || !result.caeFchVto) {
        await updateOrphan(db, key, row.id, { estado: "incierto", errores: phaseFailure(RECONCILIATION_UNCERTAIN_REASON, "reconciliation") });
        throw new ComprobanteEmissionError(RECONCILIATION_UNCERTAIN_REASON);
      } else await updateOrphan(db, key, row.id, { estado: "aprobado", cae: result.cae, caeVto: result.caeFchVto, resultado: "A", errores: null });
    } catch (error) {
      if (error instanceof ComprobanteEmissionError && [RECONCILIATION_UNCERTAIN_REASON, RECONCILIATION_MISMATCH_REASON].includes(error.message)) throw error;
      const reason = `${RECONCILIATION_UNCERTAIN_REASON} Causa: ${emissionFailureCause(error)}`;
      await updateOrphan(db, key, row.id, { estado: "incierto", errores: phaseFailure(reason, "reconciliation") });
      throw new ComprobanteEmissionError(reason);
    }
  }
}

export interface SeriesRecoveryInput {
  key: string;
  environment: ComprobanteAmbiente;
  emisorCuit: string;
  ptoVta: number;
  cbteTipo: number;
}

/**
 * Explicit, read-only-first recovery for a crashed owner. FECompConsultar is
 * used for every pending/incierto reservation; the durable claim is released
 * only after all rows have a terminal outcome and only for the observed claim
 * generation. This function never calls FECAESolicitar.
 */
export async function recoverSeriesClaim(deps: ComprobanteEmissionDeps, input: SeriesRecoveryInput): Promise<void> {
  if (deps.env) assertEmissionConfiguration(deps.env);
  else if (input.environment === "produccion") assertEmissionConfiguration({ EMISSIONS_ENABLED: "true", ARCA_ENV: "production" });
  const expectedKey = seriesKey(input.environment, input.emisorCuit, input.ptoVta, input.cbteTipo);
  if (input.key !== expectedKey) throw new ComprobanteEmissionError("La clave de recuperación no coincide con la serie solicitada.");
  const observed = await claimFor(deps.db, input.key);
  if (!observed) return;
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  if (observed.owner && observed.leaseExpiresAtMs > nowMs) throw new ComprobanteEmissionError(SERIES_BLOCKED_MESSAGE);
  if (observed.uncertain && !observed.owner) {
    const grace = deps.uncertainGraceMs ?? uncertainGraceMs(input.environment, deps.env ?? process.env);
    const uncertainAt = observed.uncertainSinceMs ?? observed.leaseExpiresAtMs;
    if (nowMs - uncertainAt < grace) throw new ComprobanteEmissionError(SERIES_BLOCKED_MESSAGE);
  }
  const owner = randomUUID();
  if (!await acquireExpiredSeriesClaim(deps.db, observed, owner, nowMs)) throw new ComprobanteEmissionError(SERIES_BLOCKED_MESSAGE);
  let reconciled = false;
  try {
    const legacyEnvironment = input.environment === "produccion" ? "production" : "homologacion";
    const legacyRows = await deps.db.select({ id: issuedInvoices.id }).from(issuedInvoices).where(and(
      eq(issuedInvoices.cuit, input.emisorCuit), eq(issuedInvoices.ptoVta, input.ptoVta), eq(issuedInvoices.cbteTipo, input.cbteTipo),
      isNull(issuedInvoices.cae), or(eq(issuedInvoices.environment, legacyEnvironment), isNull(issuedInvoices.environment)),
    ));
    if (legacyRows.length > 0) throw new ComprobanteEmissionError(LEGACY_SERIES_RECOVERY_REQUIRED);
    await reconcileOrphans(deps.db, deps, input.key, input.environment, input.emisorCuit, input.ptoVta, input.cbteTipo);
    reconciled = true;
  } finally {
    await finishSeriesClaim(deps.db, input.key, owner, reconciled, (deps.now ?? (() => new Date()))().getTime());
  }
}
/** Verify one reserved comprobante. This path never sends FECAESolicitar. */
export async function verifyComprobante(deps: ComprobanteEmissionDeps, id: string, empresaId: string): Promise<ComprobanteEmissionResult> {
  const environment = resolveArcaEnvironment(deps.env ?? process.env);
  if (environment !== "homologacion") throw new ComprobanteEmissionError("La verificación solo está habilitada en homologación.");
  const [row] = await deps.db.select().from(comprobantes).where(and(eq(comprobantes.id, id), eq(comprobantes.empresaId, empresaId), eq(comprobantes.ambiente, "homologacion")));
  if (!row) throw new ComprobanteEmissionError("No se encontró el comprobante de esta empresa.");
  if (row.estado !== "incierto" && row.estado !== "pendiente") return resultFromRow(row, false);
  const key = seriesKey(row.ambiente, row.emisorCuit, row.ptoVta, row.cbteTipo);
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  const observed = await claimFor(deps.db, key);
  const owner = randomUUID();
  const grace = deps.uncertainGraceMs ?? uncertainGraceMs(row.ambiente, deps.env ?? process.env);
  if (!observed && grace > 0 && nowMs - row.updatedAt.getTime() < grace) throw new ComprobanteEmissionError("El período de seguridad de la emisión todavía no terminó; vuelva a verificar más tarde.");
  if (observed) {
    if (observed.owner && observed.leaseExpiresAtMs > nowMs) throw new ComprobanteEmissionError(SERIES_BLOCKED_MESSAGE);
    const uncertainAt = observed.uncertainSinceMs ?? observed.leaseExpiresAtMs;
    if (observed.uncertain && nowMs - uncertainAt < grace) throw new ComprobanteEmissionError("El período de seguridad de la emisión todavía no terminó; vuelva a verificar más tarde.");
    if (!await acquireExpiredSeriesClaim(deps.db, observed, owner, nowMs)) throw new ComprobanteEmissionError(SERIES_BLOCKED_MESSAGE);
  } else if (!await withSeriesLock(deps.db, key, tx => acquireSeriesClaim(tx, key, owner, nowMs))) throw new ComprobanteEmissionError(SERIES_BLOCKED_MESSAGE);
  let resolved = false;
  try {
    await reconcileOrphans(deps.db, deps, key, row.ambiente, row.emisorCuit, row.ptoVta, row.cbteTipo, row.id);
    const legacyReservations = await deps.db.select({ id: issuedInvoices.id }).from(issuedInvoices).where(and(
      eq(issuedInvoices.cuit, row.emisorCuit), eq(issuedInvoices.ptoVta, row.ptoVta), eq(issuedInvoices.cbteTipo, row.cbteTipo),
      isNull(issuedInvoices.cae), or(eq(issuedInvoices.environment, "homologacion"), isNull(issuedInvoices.environment)),
    ));
    resolved = legacyReservations.length === 0 && (await readOrphans(deps.db, key, row.ambiente, row.emisorCuit, row.ptoVta, row.cbteTipo)).length === 0;
    const [updated] = await deps.db.select().from(comprobantes).where(and(eq(comprobantes.id, id), eq(comprobantes.empresaId, empresaId)));
    return resultFromRow(updated!, false);
  } finally { await finishSeriesClaim(deps.db, key, owner, resolved, nowMs); }
}
function resultFromRow(row: typeof comprobantes.$inferSelect, emitted: boolean): ComprobanteEmissionResult {
  return { id: row.id, empresaId: row.empresaId, estado: row.estado as ComprobanteEmissionResult["estado"], cbteNro: row.cbteNro, cae: row.cae, caeVto: row.caeVto, resultado: row.resultado, errores: row.errores, emitted };
}
async function persistById(db: Db, key: string, id: string, patch: Partial<typeof comprobantes.$inferInsert>): Promise<typeof comprobantes.$inferSelect> {
  return withSeriesLock(db, key, async (tx) => {
    const [row] = await tx.update(comprobantes).set({ ...patch, updatedAt: new Date() }).where(eq(comprobantes.id, id)).returning();
    if (!row) throw new ComprobanteEmissionError("No se encontró el comprobante reservado.");
    return row;
  });
}

async function emitComprobanteInner(deps: ComprobanteEmissionDeps, input: ComprobanteEmissionInput): Promise<ComprobanteEmissionResult> {
  const env = deps.env ?? process.env;
  assertEmissionConfiguration(env);
  const configuredEnvironment = deps.environment ?? resolveArcaEnvironment(env ?? { ARCA_ENV: "homologacion" });
  const environment: ComprobanteAmbiente = configuredEnvironment === "production" ? "produccion" : configuredEnvironment;
  const now = deps.now ?? (() => new Date());
  tracePhase("validation");
  const validated = validateComprobante({ ...input, ambiente: environment, estado: "borrador" });
  assertArcaDateWindow(validated.fecha, now());
  if (!input.idempotencyKey.trim()) throw new ComprobanteEmissionError("La clave de idempotencia es obligatoria.");
  const existingPreflight = await readByIdempotency(deps.db, input.empresaId, input.idempotencyKey);
  if (existingPreflight) {
    const sameTuple = existingPreflight.ambiente === environment && existingPreflight.emisorCuit === validated.emisorCuit && existingPreflight.ptoVta === validated.ptoVta && existingPreflight.cbteTipo === validated.cbteTipo;
    if (!sameTuple) throw new ComprobanteEmissionError(IDEMPOTENCY_CONFLICT_REASON);
    if (existingPreflight.estado === "aprobado" || existingPreflight.estado === "rechazado") return resultFromRow(existingPreflight, false);
    if (existingPreflight.estado === "borrador") throw new ComprobanteEmissionError("El comprobante existente está en borrador y requiere aprobación explícita.");
    // Pending/incierto reservations must pass through the normal claim and
    // reconciliation path. Returning here would strand a timed-out credit
    // note forever and bypass the read-only FECompConsultar recovery.
  }
  // This read-side validation deliberately runs before any series claim or
  // gateway operation: an invalid credit note must never contact ARCA.
  const creditAssociation = await validateCreditNote(deps.db, input, validated);
  const key = seriesKey(environment, validated.emisorCuit, validated.ptoVta, validated.cbteTipo);
  const owner = randomUUID();

  const initialClaim = await claimFor(deps.db, key);
  if (initialClaim?.owner) await waitForNoOwner(deps.db, key);
  const staleClaim = await claimFor(deps.db, key);
  const grace = deps.uncertainGraceMs ?? uncertainGraceMs(environment, deps.env ?? process.env);
  if (staleClaim?.uncertain && !staleClaim.owner) {
    const uncertainAt = staleClaim.uncertainSinceMs ?? staleClaim.leaseExpiresAtMs;
    if ((now().getTime() - uncertainAt) < grace) throw new ComprobanteEmissionError(SERIES_BLOCKED_MESSAGE);
  }
  if (staleClaim?.uncertain && !staleClaim.owner) await clearUncertainClaim(deps.db, key, staleClaim);
  await claimSeries(deps.db, key, owner);
  tracePhase("claim");

  let authorized = false;
  let reservationPersisted = false;
  let uncertainOutcome = false;
  let reconciliationCompleted = false;
  try {
    await reconcileOrphans(deps.db, deps, key, environment, validated.emisorCuit, validated.ptoVta, validated.cbteTipo);
    const postReconciliationOrphans = await readOrphans(deps.db, key, environment, validated.emisorCuit, validated.ptoVta, validated.cbteTipo);
    if (postReconciliationOrphans.length > 0) throw new ComprobanteEmissionError(RECONCILIATION_UNCERTAIN_REASON);
    if (!await ownsSeriesClaim(deps.db, key, owner, () => now().getTime())) throw new ComprobanteEmissionError(SERIES_BLOCKED_MESSAGE);
    reconciliationCompleted = true;
    const [empresa] = await deps.db.select({ cuit: clients.cuit }).from(clients).where(eq(clients.id, input.empresaId));
    if (!empresa || empresa.cuit !== validated.emisorCuit) throw new ComprobanteEmissionError("La empresa no coincide con el CUIT emisor del comprobante.");
    const existing = await readByIdempotency(deps.db, input.empresaId, input.idempotencyKey);
    if (existing) {
      const sameTuple = existing.ambiente === environment && existing.emisorCuit === validated.emisorCuit && existing.ptoVta === validated.ptoVta && existing.cbteTipo === validated.cbteTipo;
      if (!sameTuple) throw new ComprobanteEmissionError(IDEMPOTENCY_CONFLICT_REASON);
      if (existing.estado === "aprobado" || existing.estado === "rechazado") return resultFromRow(existing, false);
      if (existing.estado === "borrador") throw new ComprobanteEmissionError("El comprobante existente está en borrador y requiere aprobación explícita.");
      throw new ComprobanteEmissionError(RECONCILIATION_UNCERTAIN_REASON);
    }
    tracePhase("last_number");
    const last = await deps.gateway.ultimoAutorizado(validated.emisorCuit, validated.ptoVta, validated.cbteTipo as 1 | 6 | 11);
    if (!Number.isInteger(last) || last < 0 || last >= 99_999_999) throw new ComprobanteEmissionError("FECompUltimoAutorizado devolvió un número inválido.");
    const cbteNro = last + 1;
    const [reserved] = await withSeriesLock(deps.db, key, async (tx) => tx.insert(comprobantes).values({
      empresaId: input.empresaId, ambiente: environment, emisorCuit: validated.emisorCuit, emisorCondicionIva: validated.emisorCondicionIva,
      cbteTipo: validated.cbteTipo, ptoVta: validated.ptoVta, cbteNro, concepto: validated.concepto, docTipo: validated.docTipo, docNro: validated.docNro,
      condicionIvaReceptor: validated.condicionIvaReceptor, fecha: validated.fecha, importeNetoCentavos: validated.importeNetoCentavos,
      importeIvaCentavos: validated.importeIvaCentavos, importeExentoCentavos: validated.importeExentoCentavos, importeTributosCentavos: validated.importeTributosCentavos,
      importeTotalCentavos: validated.importeTotalCentavos, items: validated.items, estado: "pendiente", idempotencyKey: input.idempotencyKey,
      comprobanteAsociadoId: input.comprobanteAsociadoId ?? null,
    }).returning());
    if (!reserved) throw new ComprobanteEmissionError("No se pudo persistir la reserva del comprobante.");
    reservationPersisted = true;
    setTraceComprobante(reserved.id);
    tracePhase("reservation", { cbteNro: reserved.cbteNro });
    let dispatched = false;
    let remoteNumberAdvanced = false;
    try {
      await deps.beforeArca?.();
      // Re-read ARCA immediately before dispatch. If the candidate has already
      // advanced remotely, never send it: consult the pinned number or leave it
      // uncertain for explicit recovery. This prevents reissuing a number ARCA
      // may have approved outside this process.
      let latest: number;
      try {
        tracePhase("last_number");
        latest = await deps.gateway.ultimoAutorizado(validated.emisorCuit, validated.ptoVta, validated.cbteTipo as 1 | 6 | 11);
      } catch (error) {
        throw error;
      }
      if (!Number.isInteger(latest) || latest < 0 || latest > 99_999_999) throw new ComprobanteEmissionError(EMISSION_UNCERTAIN_REASON);
      if (latest >= reserved.cbteNro!) {
        remoteNumberAdvanced = true;
        const observed = deps.gateway.consultInvoice ? await deps.gateway.consultInvoice(comprobanteToFecaReq(reserved, creditAssociation)) : null;
        if (observed && isMatchingResult(reserved, observed) && observed.cae && observed.caeFchVto) {
          const approved = await persistById(deps.db, key, reserved.id, { estado: "aprobado", cae: observed.cae, caeVto: observed.caeFchVto, resultado: "A", errores: null });
          authorized = true;
          return resultFromRow(approved, false);
        }
        throw new ComprobanteEmissionError(EMISSION_UNCERTAIN_REASON);
      }
      tracePhase("preparation");
      const result = await deps.gateway.issueInvoice(comprobanteToFecaReq(reserved, creditAssociation), async () => {
        if (!await ownsSeriesClaim(deps.db, key, owner)) {
          throw new ComprobanteEmissionError("La reserva perdió el lock de la serie; requiere verificación manual.");
        }
      }, () => {
        dispatched = true;
        tracePhase("dispatched");
      });
      tracePhase("response");
      if (!isMatchingResult(reserved, result) || !result.cae || !result.caeFchVto) throw new Error("Respuesta ARCA ilegible o inconsistente.");
      const approved = await persistById(deps.db, key, reserved.id, { estado: "aprobado", cae: result.cae, caeVto: result.caeFchVto, resultado: "A", errores: null });
      authorized = true;
      return resultFromRow(approved, true);
    } catch (error) {
      traceFailure(emissionFailureCause(error), {
        dispatched,
        trace: error instanceof Error ? error.stack?.split("\n").filter(line => line.trimStart().startsWith("at ")).slice(0, 10).map(sanitizeFaultText) : undefined,
      });
      if (!dispatched && !remoteNumberAdvanced) {
        const local = await persistById(deps.db, key, reserved.id, { estado: "rechazado", resultado: "L", errores: phaseFailure(`Fallo local antes de enviar a ARCA: ${emissionFailureCause(error)}`), observaciones: "FECAESolicitar no fue enviado. El número queda liberado." });
        return resultFromRow(local, false);
      }
      if (isDefinitiveRejection(error)) {
        uncertainOutcome = true;
        const rejected = await persistById(deps.db, key, reserved.id, { estado: "rechazado", resultado: "R", errores: phaseFailure(rejectionReason(error)) });
        uncertainOutcome = false;
        return resultFromRow(rejected, false);
      }
      uncertainOutcome = true;
      const uncertain = await persistById(deps.db, key, reserved.id, { estado: "incierto", errores: phaseFailure(`${EMISSION_UNCERTAIN_REASON} Causa: ${emissionFailureCause(error)}`), observaciones: dispatched ? "Solicitud FECAESolicitar enviada; autorización pendiente de verificar." : "La numeración ya avanzó en ARCA; requiere consulta del comprobante." });
      return resultFromRow(uncertain, false);
    }
  } finally {
    await releaseClaim(deps.db, key, owner, authorized || (!uncertainOutcome && (reservationPersisted || reconciliationCompleted)), now().getTime());
  }
}
export async function emitComprobante(deps: ComprobanteEmissionDeps, input: ComprobanteEmissionInput): Promise<ComprobanteEmissionResult> {
  return withEmissionTrace(input.idempotencyKey ?? "unvalidated", async () => {
    try {
      const result = await emitComprobanteInner(deps, input);
      tracePhase("final", { estado: result.estado, comprobanteId: result.id });
      return result;
    } catch (error) {
      traceFailure(emissionFailureCause(error));
      throw error;
    }
  });
}
export const emitFiscalComprobante = emitComprobante;
