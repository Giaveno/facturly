/**
 * Accountant authorization seam — the SINGLE enforcement point for routes that
 * must only run as the authenticated accountant (approve/reject).
 *
 * This is a FAIL-CLOSED placeholder. Real authentication (NextAuth) is a
 * SEPARATE slice; until it lands, every protected route must call this helper
 * FIRST, and it DENIES by default so no route can be accidentally left open.
 *
 * TODO(auth-slice): replace `deny()` with the real NextAuth session check
 * (`getServerSession(authOptions)`), verify the session's user is the sole
 * accountant, and return (or throw `UnauthorizedError`) accordingly. This seam
 * is intentionally the only place that changes — the routes do not.
 */

/** Thrown (or returned as 401) when the caller is not the authenticated accountant. */
export class UnauthorizedError extends Error {
  constructor() {
    super("Authentication required — not yet wired (auth slice)");
    this.name = "UnauthorizedError";
  }
}

/**
 * Asserts the caller is the authenticated accountant. FAILS CLOSED: today it
 * always throws `UnauthorizedError`, so a protected route can never run while
 * auth is unwired.
 */
export function requireAccountantSession(_request: Request): void {
  // TODO(auth-slice): resolve the real session and verify the accountant.
  void _request; // placeholder until the real session check lands
  throw new UnauthorizedError();
}

/** True when the error is our auth-seam denial (used to map it to HTTP 401). */
export function isUnauthorizedError(err: unknown): boolean {
  return err instanceof UnauthorizedError;
}
