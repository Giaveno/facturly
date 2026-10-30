import { AsyncLocalStorage } from "node:async_hooks";
import { createConsoleLogger } from "@/adapters/arca/logger";
import { runWithCorrelationId } from "@/adapters/arca/correlation";
import { sanitizeFaultText } from "@/adapters/arca/query-diagnostics";

export const phaseLabels = { job_received: "Job recibido", validation: "Validación", claim: "Claim adquirido", reservation: "Número reservado", last_number: "Consulta del último número", wsaa: "Autenticación WSAA", preparation: "Armado del pedido", dispatched: "Pedido enviado", response: "Respuesta recibida", reconciliation: "Conciliación", final: "Estado final" } as const;
export type EmissionPhase = keyof typeof phaseLabels;
const context = new AsyncLocalStorage<{ phase: EmissionPhase; comprobanteId?: string }>();
const logger = createConsoleLogger();
export function tracePhase(phase: EmissionPhase, fields: Record<string, string | number | boolean | null | undefined> = {}) {
  const state = context.getStore();
  if (state) state.phase = phase;
  logger.info("emission_phase", { phase, comprobanteId: state?.comprobanteId, ...fields });
}
export function emissionPhase(): EmissionPhase { return context.getStore()?.phase ?? "validation"; }
export function setTraceComprobante(id: string) { const state = context.getStore(); if (state) state.comprobanteId = id; }
export function withEmissionTrace<T>(key: string, work: () => Promise<T>): Promise<T> {
  const parent = context.getStore();
  return context.run({ phase: "validation" }, () => parent ? work() : runWithCorrelationId(key, work)) as Promise<T>;
}
/** Backward-compatible diagnostic envelope stored in the existing errores text. */
export function phaseFailure(cause: string, phase: EmissionPhase = emissionPhase()): string {
  return JSON.stringify({ phase, cause: sanitizeFaultText(cause) });
}

/** Restore the caller phase on success; a failure retains its precise nested phase. */
export async function withPhase<T>(phase: EmissionPhase, work: () => Promise<T>): Promise<T> {
  const state = context.getStore();
  const previous = state?.phase;
  if (state) state.phase = phase;
  const result = await work();
  if (state && previous) state.phase = previous;
  return result;
}
export function traceFailure(cause: string, fields: Record<string, unknown> = {}) {
  logger.error("emission_failed", { phase: emissionPhase(), comprobanteId: context.getStore()?.comprobanteId, cause: sanitizeFaultText(cause), ...fields });
}
