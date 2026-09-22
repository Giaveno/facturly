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
