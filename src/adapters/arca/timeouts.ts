/** Homologacion may be slow; production budgets are deliberately unchanged. */
export const HOMOLOGACION_CALL_MS = 25_000;
export const HOMOLOGACION_ACQUISITION_MS = 30_000;
export const HOMOLOGACION_QUERY_MS = 65_000;
export const HOMOLOGACION_UI_MS = 70_000;
export function arcaTimeouts(environment: string | undefined) {
  return environment === "homologacion" ? { callMs:HOMOLOGACION_CALL_MS, acquisitionMs:HOMOLOGACION_ACQUISITION_MS } : { callMs:20_000, acquisitionMs:8_000 };
}
