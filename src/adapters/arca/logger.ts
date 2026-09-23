/**
 * Minimal structured JSON logging + counters for the ARCA adapters.
 *
 * An operator diagnosing a failed emission needs: a correlation id to tie a
 * request together, the ARCA code + message, attempt/outcome, duration, and
 * counters for WSAA failures, cooldowns, ARCA rejections, timeouts, and
 * duplicates. This module provides all of that WITHOUT ever logging token, sign,
 * private key, or certificate contents (CAE and ARCA codes are fine — they are
 * not secret).
 */

import { correlationId } from "./correlation";

/** Structured log field bag (values must be JSON-serializable). */
export type LogFields = Record<string, unknown>;

/** A minimal leveled logger. */
export interface ArcaLogger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

/** Named monotonic counters (WSAA failures, cooldowns, rejections, …). */
export interface ArcaMetrics {
  increment(name: string, by?: number): void;
  /** Snapshot for assertions/tests. */
  snapshot(): Record<string, number>;
}

/** A no-op logger (safe default when observability is not wired). */
export const noopLogger: ArcaLogger = {
  info() {},
  warn() {},
  error() {},
};

/** A no-op metrics collector. */
export const noopMetrics: ArcaMetrics = {
  increment() {},
  snapshot() {
    return {};
  },
};

/** An in-memory metrics collector (also usable in tests for assertions). */
export function createInMemoryMetrics(): ArcaMetrics {
  const counters = new Map<string, number>();
  return {
    increment(name, by = 1) {
      counters.set(name, (counters.get(name) ?? 0) + by);
    },
    snapshot() {
      return Object.fromEntries(counters);
    },
  };
}

/**
 * A JSON-lines logger. Each call emits one `JSON.stringify`-ed object to the
 * provided `write` sink (default: `console.error` for warn/error, `console.log`
 * for info). The correlation id is always included.
 */
export function createJsonLogger(
  write: (line: string) => void,
): ArcaLogger {
  function log(levelName: string, event: string, fields?: LogFields): void {
    write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: levelName,
        correlation_id: correlationId(),
        event,
        ...fields,
      }),
    );
  }
  return {
    info: (event, fields) => log("info", event, fields),
    warn: (event, fields) => log("warn", event, fields),
    error: (event, fields) => log("error", event, fields),
  };
}

/** A logger writing info to stdout and warn/error to stderr. */
export function createConsoleLogger(): ArcaLogger {
  const info = createJsonLogger((line) => console.log(line));
  const warnErr = createJsonLogger((line) => console.error(line));
  return {
    info: info.info,
    warn: warnErr.warn,
    error: warnErr.error,
  };
}
