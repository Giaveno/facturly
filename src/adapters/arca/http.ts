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
 *   - SOAP `<Fault>` bodies are parsed and surfaced (faultcode/faultstring);
 *   - 429 honours `Retry-After`;
 *   - structured logging + counters (timeouts, transient failures).
 */

import { ArcaAuthError, ArcaBusinessError, ArcaTransientError, classifyFaultCode, parseSoapFault } from "./errors";
import { noopLogger, noopMetrics, type ArcaLogger, type ArcaMetrics } from "./logger";

/** Minimal HTTP POST contract shared by all three adapters. */
export interface HttpTransport {
  post(url: string, body: string, headers: Record<string, string>): Promise<string>;
}

/** Per-call timeout budget for an outbound ARCA call. */
export const DEFAULT_TIMEOUT_MS = 20_000;

export interface FetchTransportOptions {
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
    async post(url, body, headers) {
      let res: Response;
      try {
        res = await fetchFn(url, {
          method: "POST",
          body,
          headers,
          signal: abortSignalTimeout(timeoutMs),
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
          message: err instanceof Error ? err.message : String(err),
        });
        throw new ArcaTransientError(
          isTimeout
            ? `Timeout after ${timeoutMs}ms calling ${url}`
            : `Network error calling ${url}`,
          { cause: err },
        );
      }

      // Read the body INSIDE the same abort signal so a hung body also aborts.
      let text: string;
      try {
        text = await res.text();
      } catch (err) {
        metrics.increment("arca_timeout");
        logger.error("arca_timeout", { url, message: err instanceof Error ? err.message : String(err) });
        throw new ArcaTransientError(`Timeout reading response body from ${url}`, { cause: err });
      }

      // A SOAP Fault can arrive as HTTP 500 (most common) OR HTTP 200.
      const fault = parseSoapFault(text);
      if (fault) {
        const kind = classifyFaultCode(fault.faultcode);
        const message = `SOAP Fault from ${url}` +
          (fault.faultcode ? ` (faultcode=${fault.faultcode})` : "") +
          (fault.faultstring ? `: ${fault.faultstring}` : "");
        logger.error("soap_fault", { url, kind, faultcode: fault.faultcode, faultstring: fault.faultstring });
        metrics.increment("soap_fault");
        if (kind === "auth") throw new ArcaAuthError(message, fault);
        if (kind === "transient") throw new ArcaTransientError(message, fault);
        throw new ArcaBusinessError(message, fault);
      }

      if (!res.ok) {
        const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
        // 429 + 5xx are transient; 401/403 are auth; other 4xx are permanent.
        if (res.status === 429 || res.status >= 500) {
          metrics.increment("http_transient");
          logger.warn("http_transient", { url, status: res.status, retry_after_ms: retryAfterMs });
          throw new ArcaTransientError(`HTTP ${res.status} from ${url}`, { retryAfterMs });
        }
        if (res.status === 401 || res.status === 403) {
          metrics.increment("http_auth");
          logger.error("http_auth", { url, status: res.status });
          throw new ArcaAuthError(`HTTP ${res.status} from ${url}`);
        }
        metrics.increment("http_business");
        logger.error("http_business", { url, status: res.status });
        throw new ArcaBusinessError(`HTTP ${res.status} from ${url}`);
      }

      return text;
    },
  };
}
