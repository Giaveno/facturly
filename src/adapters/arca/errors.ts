/**
 * Typed ARCA error taxonomy.
 *
 * The transport and gateway previously collapsed every failure into a bare
 * `Error("HTTP <status>")`, making transient failures (network/timeout/429/5xx)
 * indistinguishable from permanent ones (ARCA validation rejections), and
 * discarding SOAP Fault bodies. This module introduces three distinct error
 * classes so callers (and the retry/cooldown logic) can react appropriately:
 *
 *   - `ArcaTransientError` — network, timeout, 429, 5xx. Safe to retry.
 *   - `ArcaBusinessError` — ARCA rejected the request permanently (validation,
 *     a `<soap:Fault>`, or a non-auth business error code).
 *   - `ArcaAuthError`      — token/sign/delegation/certificate failures. The
 *     caller should evict the TA and retry ONCE with a fresh ticket.
 *
 * Security: SOAP text is untrusted. HTTP and emission boundaries retain only
 * fixed categories and bounded numeric codes, never arbitrary provider text.
 */

import { XMLParser } from "fast-xml-parser";
import { safeQueryDiagnostic, type QueryCategory } from "./query-diagnostics";

export type EmissionStage = "ultimo" | "issuance";

/** The three failure classes ARCA integration distinguishes. */
export type ArcaErrorKind = "transient" | "business" | "auth";

type KnownFaultCode =
  | "coe.alreadyAuthenticated"
  | "coe.notAuthorized"
  | "cms.cert.untrusted"
  | "cms.cert.expired"
  | "cms.sign.invalid"
  | "xml.generationTime.invalid"
  | "xml.expirationTime.expired";

const ALLOWED_FAULT_CODES: readonly KnownFaultCode[] = [
  "coe.alreadyAuthenticated",
  "coe.notAuthorized",
  "cms.cert.untrusted",
  "cms.cert.expired",
  "cms.sign.invalid",
  "xml.generationTime.invalid",
  "xml.expirationTime.expired",
];

export type NormalizedFaultCode = KnownFaultCode | "unknown";

function isAllowedFaultCode(value: string): value is KnownFaultCode {
  return ALLOWED_FAULT_CODES.some((faultcode) => faultcode === value);
}

function unqualifiedFaultCode(faultcode: string | undefined): string {
  const trimmed = faultcode?.trim() ?? "";
  const separator = trimmed.lastIndexOf(":");
  return separator >= 0 ? trimmed.slice(separator + 1) : trimmed;
}

export function normalizeFaultCode(faultcode: string | undefined): NormalizedFaultCode {
  const unqualified = unqualifiedFaultCode(faultcode);
  return isAllowedFaultCode(unqualified) ? unqualified : "unknown";
}

/** Options common to every ARCA error. */
export interface ArcaErrorOptions {
  kind: ArcaErrorKind;
  message: string;
  /** ARCA validation/error code (e.g. "10049", "600"). */
  code?: string;
  /** SOAP 1.1 `faultcode`, when the failure arrived as a `<soap:Fault>`. */
  faultcode?: string;
  /** SOAP 1.1 `faultstring`, when the failure arrived as a `<soap:Fault>`. */
  faultstring?: string;
  /** Seconds to wait before retrying, from a 429 `Retry-After` header. */
  retryAfterMs?: number;
  cause?: unknown;
  stage?: EmissionStage;
  category?: QueryCategory;
  providerCodes?: number[];
  httpStatus?: number;
}

/** Base class for every typed ARCA failure. */
export class ArcaError extends Error {
  readonly kind: ArcaErrorKind;
  readonly code?: string;
  readonly faultcode?: string;
  readonly faultstring?: string;
  readonly retryAfterMs?: number;
  readonly stage?: EmissionStage;
  readonly category?: QueryCategory;
  readonly providerCodes?: number[];
  readonly httpStatus?: number;

  constructor(options: ArcaErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = "ArcaError";
    this.kind = options.kind;
    this.code = options.code;
    this.faultcode = options.faultcode === undefined ? undefined : normalizeFaultCode(options.faultcode);
    this.faultstring = undefined;
    this.retryAfterMs = options.retryAfterMs;
    this.stage = options.stage;
    this.category = options.category;
    this.providerCodes = options.providerCodes;
    this.httpStatus = options.httpStatus;
  }
}

/** A failure that is safe to retry (network, timeout, 429, 5xx). */
export class ArcaTransientError extends ArcaError {
  constructor(message: string, options: Omit<ArcaErrorOptions, "kind" | "message"> = {}) {
    super({ ...options, kind: "transient", message });
    this.name = "ArcaTransientError";
  }
}

/** A permanent ARCA rejection (validation or a business `<soap:Fault>`). */
export class ArcaBusinessError extends ArcaError {
  constructor(message: string, options: Omit<ArcaErrorOptions, "kind" | "message"> = {}) {
    super({ ...options, kind: "business", message });
    this.name = "ArcaBusinessError";
  }
}

/** A token/sign/delegation/certificate failure — evict the TA, retry once. */
export class ArcaAuthError extends ArcaError {
  constructor(message: string, options: Omit<ArcaErrorOptions, "kind" | "message"> = {}) {
    super({ ...options, kind: "auth", message });
    this.name = "ArcaAuthError";
  }
}

/** Rebuild boundary errors from allowlisted metadata, never provider text or causes. */
export function safeEmissionError(err: unknown, stage: EmissionStage): ArcaError {
  const typed = err instanceof ArcaError ? err : undefined;
  const code = typed?.code && /^\d{1,9}$/.test(typed.code) ? typed.code : undefined;
  const diagnostic = safeQueryDiagnostic({
    stage: "wsfe",
    category: typed?.category ?? (code ? "provider-errors" : typed ? "http" : "internal"),
    providerCodes: typed?.providerCodes ?? (code ? [Number(code)] : undefined),
    httpStatus: typed?.httpStatus,
  }) ?? { stage: "wsfe", category: "internal" };
  const details = {
    stage, category: diagnostic.category, code,
    providerCodes: diagnostic.providerCodes, httpStatus: diagnostic.httpStatus,
  };
  const message = `ARCA ${stage} failed (${diagnostic.category}${code ? `, code=${code}` : ""})` + (stage === "issuance" && diagnostic.category === "malformed-response" ? "; outcome uncertain; read-only verification required" : "");
  if (typed?.kind === "business") return new ArcaBusinessError(message, details);
  if (typed?.kind === "auth") return new ArcaAuthError(message, details);
  return new ArcaTransientError(message, details);
}

/** A parsed SOAP 1.1 `Fault` (surfaced instead of being discarded). */
export interface SoapFault {
  faultcode?: string;
  faultstring?: string;
}

const XML_PARSER = () =>
  new XMLParser({
    removeNSPrefix: true,
    ignoreAttributes: true,
    parseTagValue: false,
    parseAttributeValue: false,
  });

/**
 * Extracts a SOAP 1.1 `Envelope.Body.Fault` from a response body, or `null`
 * when the body is not a Fault. SOAP Faults arrive as HTTP 500 (and sometimes
 * HTTP 200); this lets the transport surface `faultcode`/`faultstring` instead
 * of a bare "HTTP 500".
 */
export function parseSoapFault(soapXml: string): SoapFault | null {
  let parsed: unknown;
  try {
    parsed = XML_PARSER().parse(soapXml);
  } catch {
    return null;
  }
  const body = parsed as {
    Envelope?: { Body?: { Fault?: { faultcode?: unknown; faultstring?: unknown } } };
  };
  const fault = body?.Envelope?.Body?.Fault;
  if (!fault) return null;
  return {
    faultcode: typeof fault.faultcode === "string" ? fault.faultcode : undefined,
    faultstring:
      typeof fault.faultstring === "string" ? fault.faultstring : undefined,
  };
}

/** True when the response body is a SOAP Fault envelope. */
export function hasSoapFault(soapXml: string): boolean {
  return parseSoapFault(soapXml) !== null;
}

const FAULT_CODE_KINDS = new Map<string, ArcaErrorKind>([
  ["coe.alreadyAuthenticated", "business"],
  ["coe.notAuthorized", "auth"],
  ["cms.cert.untrusted", "auth"],
  ["cms.cert.expired", "auth"],
  ["cms.sign.invalid", "auth"],
  ["xml.generationTime.invalid", "business"],
  ["xml.expirationTime.expired", "business"],
  ["Server", "transient"],
]);

/** Classifies only explicitly supported SOAP fault codes. */
export function classifyFaultCode(faultcode: string | undefined): ArcaErrorKind {
  return FAULT_CODE_KINDS.get(unqualifiedFaultCode(faultcode)) ?? "business";
}

/**
 * ARCA WSFEv1/WSAA error codes that indicate an invalid/expired token or a
 * broken delegation. These should trigger a TA eviction + one retry, not a
 * permanent failure. (Best-effort, homologación-refinable.)
 */
const AUTH_ERROR_CODES = new Set([
  "600",
  "601",
  "603",
  "604",
  "605",
  "606",
  "607",
  "608",
  "609",
  "1000",
  "1001",
  "1002",
  "1003",
  "1004",
  "1005",
  "1006",
  "1007",
]);

/** Legacy lookup category, NOT proof of authorization. 10016 can indicate a
 * numbering/date conflict; only matching FECompConsultar evidence resolves it.
 * 10015 is recipient-document validation and must never imply a duplicate. */
export const DUPLICATE_ERROR_CODES = new Set(["10016"]);

/** Classifies an ARCA validation code for the gateway's retry/evict logic. */
export function classifyArcaErrorCode(
  code: string,
): "auth" | "duplicate" | "business" {
  if (DUPLICATE_ERROR_CODES.has(code)) return "duplicate";
  if (AUTH_ERROR_CODES.has(code)) return "auth";
  return "business";
}

/** Builds an `ArcaError` for a classified ARCA code + message. */
export function arcaErrorForCode(
  code: string,
  msg: string,
): ArcaBusinessError | ArcaAuthError {
  const kind = classifyArcaErrorCode(code);
  if (kind === "auth") return new ArcaAuthError(msg, { code });
  return new ArcaBusinessError(msg, { code });
}
