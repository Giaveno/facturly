/** Pure client-safe decoding of persisted fiscal diagnostics. */
export function emissionDiagnostic(raw: string | null | undefined): { phase?: string; cause: string } {
  if (!raw) return { cause: "" };
  try { const value = JSON.parse(raw); if (typeof value.phase === "string" && typeof value.cause === "string") return value; } catch { /* Historical plain text remains readable. */ }
  return { cause: raw };
}
export const emissionPhaseLabels: Record<string, string> = { job_received: "Job recibido", validation: "Validación", claim: "Claim adquirido", reservation: "Número reservado", last_number: "Consulta del último número", wsaa: "Autenticación WSAA", preparation: "Armado del pedido", dispatched: "Pedido enviado", response: "Respuesta recibida", reconciliation: "Conciliación", final: "Estado final" };
