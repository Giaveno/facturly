import { isValidCuit } from "@/domain/cuit";
import type { PadronLookupData } from "@/adapters/arca/padron-lookup";

export interface PadronLookupReport extends PadronLookupData {
  cuit: string;
  environment: "homologacion";
  fingerprint: string;
  checkedAt: string;
  authentication: "authenticated";
  dataResponse: "received";
}
export const HOMOLOGATION_DISCLAIMER = "Homologación: datos de prueba; no acredita situación fiscal real";
export function normalizeLookupCuit(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 32 || !/^[\d\s-]+$/.test(value)) return null;
  const normalized = value.replace(/[\s-]/g, "");
  return isValidCuit(normalized) ? normalized : null;
}
