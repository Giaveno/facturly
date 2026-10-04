/**
 * Maps a Postgres error to an HTTP client status. Foreign-key violations
 * (23503) and invalid text representation (22P02, e.g. a malformed UUID) are
 * client errors, not server errors — they must surface as 400, not 500.
 */

export function classifyDbError(err: unknown): number {
  const code = (err as { code?: string } | null)?.code;
  if (code === "23503") return 400; // FK violation → unknown client
  if (code === "22P02") return 400; // invalid text representation → bad UUID
  return 500;
}

/**
 * Detects a Postgres/PGlite unique-violation (code 23505), walking the error
 * `.cause` chain. Drizzle wraps the driver error in `DrizzleQueryError`, which
 * carries the real `code`/`message` under `.cause` — so a flat `err.code ===
 * "23505"` check MISSES the real error (reproduced: a genuine duplicate CUIT
 * surfaced as 500 instead of 409). Shared by the emission service (reservation
 * collisions) and the clients route (duplicate CUIT → 409).
 */
export function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  while (e && typeof e === "object") {
    const obj = e as { code?: string; message?: string; cause?: unknown };
    if (obj.code === "23505") return true;
    const msg = obj.message ?? "";
    if (/duplicate key value|unique constraint|unique_violation/i.test(msg)) {
      return true;
    }
    e = obj.cause;
  }
  return false;
}
