/**
 * Shared HTTP transport for the ARCA SOAP adapters.
 *
 * All three adapters (WSAA, WSFEv1, Padrón A5) post a SOAP XML body and read a
 * text response — one transport shape serves all. This `fetch`-based
 * implementation is the production one (also used by the homologación spike).
 *
 * Reliability fixes over the original single-line transport:
 *   - a per-call timeout via `AbortSignal.timeout`, covering the BODY read too;
 *   - typed errors (`ArcaTransientError`/`ArcaAuthError`/`ArcaBusinessError`)
 *     instead of a bare `Error("HTTP <status>")`;
 *   - SOAP `<Fault>` bodies are classified with safe category/status metadata;
 *   - 429 honours `Retry-After`;
 *   - structured logging + counters (timeouts, transient failures).
 */

import { ArcaAuthError, ArcaBusinessError, ArcaTransientError, classifyFaultCode, parseSoapFault } from "./errors";
import { noopLogger, noopMetrics, type ArcaLogger, type ArcaMetrics } from "./logger";

/** Minimal HTTP POST contract shared by all three adapters. */
export interface HttpTransport {
  post(url: string, body: string, headers: Record<string, string>, onDispatched?: () => void): Promise<string>;
}

/** Per-call timeout budget for an outbound ARCA call. */
export const DEFAULT_TIMEOUT_MS = 20_000;

/** Bounded diagnostic values only: no arbitrary response headers or body text. */
export interface SoapResponseMetadata {
  httpStatus: number;
  mediaType: "text/xml" | "application/soap+xml" | "application/xml" | "text/html" | "text/plain" | "other";
  shape: "html" | "xml" | "empty" | "other";
}

export interface FetchTransportOptions {
  /** Diagnostic hook receives XML in memory only; use createHomologacionCapture. */
  capture?: (direction: "request" | "response", url: string, xml: string, metadata?: SoapResponseMetadata) => void;
  /** Per-call timeout in milliseconds (default 20s). */
  timeoutMs?: number;
  logger?: ArcaLogger;
  metrics?: ArcaMetrics;
  /** Injectable fetch (defaults to the global — tests stub it). */
  fetchFn?: typeof fetch;
  /** Injectable AbortSignal.timeout (defaults to the global — tests may stub it). */
  abortSignalTimeout?: (ms: number) => AbortSignal;
}

/**
 * Parses a `Retry-After` header into milliseconds. Accepts either a delta in
 * seconds or an HTTP-date; returns undefined when absent/unparseable.
 */
export function parseRetryAfterMs(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) {
    const delta = parsed - Date.now();
    return delta > 0 ? delta : undefined;
  }
  return undefined;
}

/** A production transport backed by `fetch` (serverless-safe). */
export function createFetchTransport(options: FetchTransportOptions = {}): HttpTransport {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const logger = options.logger ?? noopLogger;
  const metrics = options.metrics ?? noopMetrics;
  const fetchFn = options.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const abortSignalTimeout = options.abortSignalTimeout ?? AbortSignal.timeout.bind(AbortSignal);

  return {
    async post(url, body, headers, onDispatched) {
      // Capture before faults/status discard the body; never enable raw logging.
      options.capture?.("request", url, body);
      const signal = abortSignalTimeout(timeoutMs);
      let res: Response;
      try {
        onDispatched?.();
        res = await fetchFn(url, {
          method: "POST",
          body,
          headers,
          signal,
        });
      } catch (err) {
        // AbortSignal.timeout throws a DOMException named "TimeoutError" (or
        // "AbortError") — classify as a timeout; everything else is a network
        // failure. Both are transient.
        const isTimeout =
          err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError");
        metrics.increment(isTimeout ? "arca_timeout" : "network_error");
        logger.error(isTimeout ? "arca_timeout" : "network_error", {
          url,
          duration_ms: undefined,
          category: isTimeout ? "timeout" : "network",
        });
        throw new ArcaTransientError(
          isTimeout
            ? `Timeout after ${timeoutMs}ms calling ${url}`
            : `Network error calling ${url}`,
          {
            category: isTimeout ? "timeout" : "network",
            // Preserve timeout identity for existing callers, never the original exception text.
            cause: isTimeout ? new DOMException("ARCA call timed out", "TimeoutError") : undefined,
          },
        );
      }

      // Read the body INSIDE the same abort signal so a hung body also aborts.
      let text: string;
      try {
        text = await res.text();
      } catch {
        metrics.increment("arca_timeout");
        logger.error("arca_timeout", { url, category: "timeout" });
        throw new ArcaTransientError("ARCA response body timed out", {
          category: "timeout", cause: new DOMException("ARCA response body timed out", "TimeoutError"),
        });
      }

      const contentType = res.headers.get("content-type")?.split(";",1)[0]?.trim().toLowerCase();
      const allowedMediaTypes = ["text/xml", "application/soap+xml", "application/xml", "text/html", "text/plain"] as const;
      const mediaType: SoapResponseMetadata["mediaType"] = allowedMediaTypes.find(type=>type===contentType) ?? "other";
      const shape: SoapResponseMetadata["shape"] = !text.trim() ? "empty" : /^(?:\s*<!doctype\s+html[^>]*>)?\s*<html\b/i.test(text) ? "html" : text.trimStart().startsWith("<") ? "xml" : "other";
      // The homologacion redactor emits an omission marker for unsafe XML. Keep
      // safe evidence even when the response cannot be parsed, never a raw fallback.
      options.capture?.("response", url, text, {httpStatus:res.status,mediaType,shape});
      if (text.length > 1_048_576 || /<!DOCTYPE|<!ENTITY/i.test(text)) {
        throw new ArcaBusinessError("ARCA response rejected", {
          category: text.length > 1_048_576 ? "response-too-large" : "malformed-response",
          httpStatus: res.status,
        });
      }
      // A SOAP Fault can arrive as HTTP 500 (most common) OR HTTP 200.
      const fault = parseSoapFault(text);
      if (fault) {
        const kind = classifyFaultCode(fault.faultcode);
        const message = "ARCA SOAP Fault";
        const details = { category: "soap-fault" as const, httpStatus: res.status };
        logger.error("soap_fault", { url, kind, category: "soap-fault", status: res.status });
        metrics.increment("soap_fault");
        if (kind === "auth") throw new ArcaAuthError(message, details);
        if (kind === "transient") throw new ArcaTransientError(message, details);
        throw new ArcaBusinessError(message, details);
      }

      if (!res.ok) {
        const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
        // 429 + 5xx are transient; 401/403 are auth; other 4xx are permanent.
        if (res.status === 429 || res.status >= 500) {
          metrics.increment("http_transient");
          logger.warn("http_transient", { url, status: res.status, retry_after_ms: retryAfterMs });
          throw new ArcaTransientError(`ARCA HTTP ${res.status}`, { retryAfterMs, category: "http", httpStatus: res.status });
        }
        if (res.status === 401 || res.status === 403) {
          metrics.increment("http_auth");
          logger.error("http_auth", { url, status: res.status });
          throw new ArcaAuthError(`ARCA HTTP ${res.status}`, { category: "http", httpStatus: res.status });
        }
        metrics.increment("http_business");
        logger.error("http_business", { url, status: res.status });
        throw new ArcaBusinessError(`ARCA HTTP ${res.status}`, { category: "http", httpStatus: res.status });
      }

      return text;
    },
  };
}
