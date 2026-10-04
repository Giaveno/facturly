/**
 * Same-origin (CSRF) check for cookie-authenticated state-changing routes.
 *
 * The session cookie is SameSite=Lax, which blocks most cross-site POSTs, but a
 * single layer of defense is not enough for actions with real fiscal
 * consequences (approve triggers a REAL ARCA emission; upload costs OCR money
 * and writes rows). This module adds an explicit Origin check: when a browser
 * sends an `Origin` header it MUST match an allowlist derived from the request
 * host (and/or the `APP_ORIGIN` env var); a mismatch is rejected.
 *
 * Requests with NO Origin header (curl, Inngest, server-to-server) are allowed —
 * CSRF is a browser attack, and those clients do not carry the accountant's
 * session cookie. This is deliberately dependency-free.
 */

/** The subset of `process.env` the allowlist reads. */
export interface OriginEnv {
  APP_ORIGIN?: string;
  NODE_ENV?: string;
  [key: string]: string | undefined;
}

/** Normalizes an origin for comparison (lowercase, strip a trailing slash). */
function normalizeOrigin(origin: string): string {
  let o = origin.trim().toLowerCase();
  if (o.endsWith("/")) o = o.slice(0, -1);
  return o;
}

/** Thrown when the allowlist cannot be built (mapped to a loud startup failure). */
export class OriginConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OriginConfigurationError";
  }
}

/**
 * The allowlist for a request: the request's own origin (scheme + host) plus any
 * explicitly configured origins in `APP_ORIGIN` (comma-separated). Behind a
 * proxy the scheme is read from `x-forwarded-proto` (defaults to `https`).
 *
 * In production (`NODE_ENV === "production"`) the request `Host` is IGNORED —
 * a forged `Host`+`Origin` pair must not be able to pass — and `APP_ORIGIN` is
 * REQUIRED. If it is missing, the allowlist refuses to build (loud failure)
 * rather than silently deriving a permissive allowlist from the request (W7).
 */
export function collectAllowedOrigins(
  req: Request,
  env: OriginEnv = process.env,
): Set<string> {
  const allowed = new Set<string>();
  const isProduction = env.NODE_ENV === "production";

  if (!isProduction) {
    const host = req.headers.get("host");
    if (host) {
      const proto = req.headers.get("x-forwarded-proto") ?? "https";
      allowed.add(normalizeOrigin(`${proto}://${host}`));
    }
  }

  const appOrigin = (env.APP_ORIGIN ?? "").trim();
  if (appOrigin) {
    for (const part of appOrigin.split(",")) {
      const o = part.trim();
      if (o) allowed.add(normalizeOrigin(o));
    }
  }

  if (isProduction && allowed.size === 0) {
    throw new OriginConfigurationError(
      "APP_ORIGIN must be set in production — refusing to derive the origin allowlist from the request Host",
    );
  }

  return allowed;
}

/** Thrown (mapped to 403) when a browser request is cross-origin. */
export class ForbiddenOriginError extends Error {
  constructor() {
    super("Cross-origin request rejected");
    this.name = "ForbiddenOriginError";
  }
}

/**
 * Asserts the request's `Origin` (when present) is same-origin. Throws
 * `ForbiddenOriginError` on a mismatch; allows requests with no Origin header.
 */
export function assertSameOrigin(
  req: Request,
  env: OriginEnv = process.env,
): void {
  const origin = req.headers.get("origin");
  if (!origin) return;
  if (!collectAllowedOrigins(req, env).has(normalizeOrigin(origin))) {
    throw new ForbiddenOriginError();
  }
}

/** True when the error is our same-origin rejection (used to map it to 403). */
export function isForbiddenOriginError(err: unknown): boolean {
  return err instanceof ForbiddenOriginError;
}
