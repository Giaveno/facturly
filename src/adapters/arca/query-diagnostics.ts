/** Bound and redact untrusted fault fields; never accept credential-like blobs. */
export function sanitizeFaultText(value: string): string {
  // Omit the entire field: line-wise redaction could expose a short wrapped tail.
  if (/[A-Za-z0-9+/_=-]{64,}/.test(value)) return "[REDACTED: credential-like fault text]";
  return value.replace(/-----BEGIN [^-]+-----[\s\S]*?(?:-----END [^-]+-----|$)/gi, "[REDACTED]")
    .replace(/\b(token|sign|password|secret|signature|cms|privatekey|cert(?:ificate)?)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[REDACTED]")
    .replace(/[A-Za-z0-9+/_=-]{64,}/g, "[REDACTED]")
    .replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300);
}
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
  /** Redacted fault fields, populated only by homologation diagnostics. */
  faultcode?: string;
  faultstring?: string;
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
  if (d.stage === "wsaa" && d.category === "soap-fault") {
    if (typeof d.faultcode === "string") safe.faultcode = sanitizeFaultText(d.faultcode);
    if (typeof d.faultstring === "string") safe.faultstring = sanitizeFaultText(d.faultstring);
  }
  return safe;
}
export class ArcaQueryError extends Error {
  readonly diagnostic: QueryDiagnostic;
  constructor(stage: QueryStage, category: QueryCategory, details: Pick<QueryDiagnostic, "httpStatus" | "providerCodes" | "faultReason" | "faultcode" | "faultstring"> = {}) {
    super(category === "timeout" ? "ARCA query timed out" : "ARCA query failed");
    this.diagnostic = safeQueryDiagnostic({ stage, category, ...details })!;
  }
}
