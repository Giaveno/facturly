/**
 * Accountant authorization seam — the SINGLE enforcement point for routes that
 * must only run as the authenticated accountant (approve/reject/pdf).
 *
 * FAIL-CLOSED: `requireAccountantSession` resolves the REAL NextAuth session and
 * throws `UnauthorizedError` whenever there is no user. An unauthenticated
 * caller can therefore never reach a protected handler. This is the only place
 * the real session is read — the routes do not change; they keep calling this
 * seam.
 *
 * The session resolver is injectable so the deny/allow behaviour is testable
 * without the Next.js request runtime (the default resolver uses `auth()`).
 */

/** Thrown (mapped to 401) when the caller is not the authenticated accountant. */
export class UnauthorizedError extends Error {
  constructor() {
    super("Authentication required");
    this.name = "UnauthorizedError";
  }
}

/**
 * Resolves the current session. Returns null (or a session with no user) when
 * the caller is unauthenticated.
 */
export type SessionResolver = () => Promise<{ user?: unknown } | null>;

/**
 * The production resolver — reads the NextAuth session via `auth()`. Loaded
 * LAZILY (dynamic import) so the seam — and everything that imports it — does
 * not statically pull `next-auth` (which imports `next/server`) into the offline
 * Vitest module graph. In a route handler the import is cached after first use.
 */
const resolveSession: SessionResolver = async () => {
  const { auth } = await import("@/auth");
  return auth();
};

/**
 * Asserts the caller is the authenticated accountant. FAILS CLOSED: throws
 * `UnauthorizedError` unless the resolved session has a user.
 */
export async function requireAccountantSession(
  resolve: SessionResolver = resolveSession,
): Promise<void> {
  let session: { user?: unknown } | null;
  try {
    session = await resolve();
  } catch {
    // FAIL-CLOSED: if the session cannot be resolved (e.g. the `@/auth` module
    // fails to load at runtime), deny rather than allow — and never surface the
    // underlying import error as a 500. A broken auth dependency must never turn
    // into an open route.
    throw new UnauthorizedError();
  }
  if (!session?.user) {
    throw new UnauthorizedError();
  }
}

/** True when the error is our auth-seam denial (used to map it to HTTP 401). */
export function isUnauthorizedError(err: unknown): boolean {
  return err instanceof UnauthorizedError;
}
