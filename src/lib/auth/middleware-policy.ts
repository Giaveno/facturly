/**
 * Middleware policy — the PURE decision logic behind the session middleware.
 *
 * Two concerns, split so each is unit-testable without a Next.js runtime:
 *
 *   1. `isExemptPath` — the single source of truth for which paths the session
 *      middleware must NEVER block: NextAuth's own routes (`/api/auth/*`), the
 *      Inngest endpoint (`/api/inngest`, which authenticates via its own signing
 *      key), the login page, and static assets.
 *
 *   2. `decideAuthResponse` — maps (isLoggedIn, pathname) to an outcome:
 *      allow, redirect-to-login (page), or 401 (API). An unauthenticated API
 *      request must get a 401, never a redirect.
 */

/** True when the path must be skipped by the session middleware entirely. */
export function isExemptPath(pathname: string): boolean {
  // NextAuth's own handlers (sign-in, callback, session, csrf) — must never be
  // wrapped by the session middleware. Exact/segment match ONLY: `/api/auth` or
  // `/api/auth/...`, NOT `/api/authz` / `/api/authentication` (those are not
  // NextAuth routes and would otherwise be silently exempted).
  if (pathname === "/api/auth" || pathname.startsWith("/api/auth/")) return true;
  // Inngest authenticates via its own signing key — NOT the accountant session.
  if (pathname === "/api/inngest" || pathname.startsWith("/api/inngest/")) {
    return true;
  }
  // The login page is the one page an unauthenticated visitor may reach.
  if (pathname === "/login" || pathname.startsWith("/login/")) return true;
  // Static assets.
  if (pathname.startsWith("/_next")) return true;
  if (pathname === "/favicon.ico") return true;
  return false;
}

export type AuthDecision =
  | { kind: "next" }
  | { kind: "redirect"; to: string }
  | { kind: "unauthorized" };

/**
 * Decides the middleware outcome for a non-exempt path. Assumes `isExemptPath`
 * already returned false (the middleware checks that first).
 */
export function decideAuthResponse(params: {
  isLoggedIn: boolean;
  pathname: string;
}): AuthDecision {
  const { isLoggedIn, pathname } = params;
  if (isLoggedIn) {
    return { kind: "next" };
  }
  const isApi = pathname.startsWith("/api/");
  if (isApi) {
    return { kind: "unauthorized" };
  }
  return { kind: "redirect", to: "/login" };
}
