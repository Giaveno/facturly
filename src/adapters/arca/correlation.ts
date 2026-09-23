/**
 * Request correlation id, threaded through the ARCA gateway via AsyncLocalStorage.
 *
 * The caller wraps a top-level operation in `runWithCorrelationId(id, fn)`; every
 * log line emitted anywhere down the call stack (transport, WSAA, WSFEv1, Padrón,
 * TA cache) carries that id. When no id is in scope, `correlationId()` returns a
 * fresh random one so a log line is never emitted without an identifier.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const storage = new AsyncLocalStorage<string>();

/** Runs `fn` with `id` as the correlation id for the duration of the call. */
export function runWithCorrelationId<T>(
  id: string,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return storage.run(id, fn);
}

/** The in-scope correlation id, or a fresh one when none is set. */
export function correlationId(): string {
  return storage.getStore() ?? randomUUID();
}
