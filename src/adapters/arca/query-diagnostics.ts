/** Public diagnostics contain only protocol stages, fixed categories and bounded numbers. */
export type QueryStage = "wsaa" | "wsfe" | "padron";
const categories = ["http", "network", "timeout", "soap-fault", "provider-errors", "malformed-response", "response-too-large", "cooldown", "internal"] as const;
export type QueryCategory = typeof categories[number];
export type PadronFaultReason = "validation-rejected" | "unclassified";
export interface QueryDiagnostic {
  stage: QueryStage;
  category: QueryCategory;
  httpStatus?: number;
  providerCodes?: number[];
  faultReason?: PadronFaultReason;
}
export function safeQueryDiagnostic(value: unknown): QueryDiagnostic | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const d = value as Record<string, unknown>;
  if ((d.stage !== "wsaa" && d.stage !== "wsfe" && d.stage !== "padron") || !categories.includes(d.category as QueryCategory)) return;
  const safe: QueryDiagnostic = { stage: d.stage, category: d.category as QueryCategory };
  if (d.stage === "padron" && d.category === "soap-fault" && (d.faultReason === "validation-rejected" || d.faultReason === "unclassified")) safe.faultReason = d.faultReason;
  if (typeof d.httpStatus === "number" && Number.isInteger(d.httpStatus) && d.httpStatus >= 100 && d.httpStatus <= 599) safe.httpStatus = d.httpStatus;
  if (Array.isArray(d.providerCodes)) {
    const codes = d.providerCodes.slice(0, 100).filter((code): code is number => typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 999_999_999).slice(0, 10);
    if (codes.length) safe.providerCodes = codes;
  }
  return safe;
}
export class ArcaQueryError extends Error {
  readonly diagnostic: QueryDiagnostic;
  constructor(stage: QueryStage, category: QueryCategory, details: Pick<QueryDiagnostic, "httpStatus" | "providerCodes" | "faultReason"> = {}) {
    super(category === "timeout" ? "ARCA query timed out" : "ARCA query failed");
    this.diagnostic = safeQueryDiagnostic({ stage, category, ...details })!;
  }
}
