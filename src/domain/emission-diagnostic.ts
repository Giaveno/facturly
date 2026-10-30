/** Pure client-safe decoding of persisted fiscal diagnostics. */
export function emissionDiagnostic(raw: string | null | undefined): { phase?: string; cause: string } {
  if (!raw) return { cause: "" };
  try { const value = JSON.parse(raw); if (typeof value.phase === "string" && typeof value.cause === "string") return value; } catch { /* Historical plain text remains readable. */ }
  return { cause: raw };
}
export const emissionPhaseLabels: Record<string, string> = { job_received: "Job recibido", validation: "Validación", claim: "Claim adquirido", reservation: "Número reservado", last_number: "Consulta del último número", wsaa: "Autenticación WSAA", preparation: "Armado del pedido", dispatched: "Pedido enviado", response: "Respuesta recibida", reconciliation: "Conciliación", final: "Estado final" };

/** Fiscal rejection is distinct from local failure or confirmed non-issuance. */
export function comprobanteStatusLabel(row: { estado: string; resultado?: string | null; errores?: string | null }): string {
  if (row.estado === "aprobado") return "Aprobado";
  if (row.estado === "incierto") return "Incierto";
  if (row.estado === "pendiente") return "Pendiente";
  if (row.estado === "borrador") return "Borrador";
  const cause = emissionDiagnostic(row.errores).cause;
  // Existing reconciliations used R; keep their dated reason readable without rewriting history.
  const absent = cause === "ARCA no encontró el comprobante reservado; no se reemitirá automáticamente.";
  if (row.resultado === "L" || row.resultado === "N" || absent) return "No emitido";
  return row.resultado === "R" ? "Rechazado" : "No emitido";
}
