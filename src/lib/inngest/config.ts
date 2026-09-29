/**
 * Inngest runtime configuration — the signing-key requirement is a security
 * boundary, not a suggestion. The Inngest endpoint exposes the emission function
 * (real invoices) and the OCR function; an unverified webhook there is a remote
 * code path with fiscal consequences.
 *
 * `INNGEST_DEV=1` silently switches Inngest into "dev" mode, which DISABLES
 * signature verification entirely. In production that would leave the emission
 * and OCR endpoints accepting unverified webhooks. This module therefore:
 *
 *   - resolves the signing key from `INNGEST_SIGNING_KEY`;
 *   - REFUSES (throws) in production when `INNGEST_DEV` is set at all;
 *   - REFUSES (throws) in production when the signing key is missing.
 *
 * The resolver is a pure function so the production assertions are unit-tested
 * without touching the Inngest SDK.
 */

/** The subset of `process.env` the resolver reads (keeps it pure/testable). */
export interface InngestEnv {
  NODE_ENV?: string;
  INNGEST_SIGNING_KEY?: string;
  INNGEST_DEV?: string;
}

/**
 * Resolves the Inngest signing key. Throws (loudly) in production when the key
 * is missing or `INNGEST_DEV` is set; returns the key (or `undefined` in
 * non-production) otherwise.
 */
export function resolveInngestSigningKey(
  env: InngestEnv = process.env,
): string | undefined {
  const isProd = env.NODE_ENV === "production";
  const key = (env.INNGEST_SIGNING_KEY ?? "").trim();

  if (isProd) {
    if (env.INNGEST_DEV !== undefined && env.INNGEST_DEV !== "") {
      throw new Error(
        "INNGEST_DEV must NEVER be set in production — it disables Inngest " +
          "signature verification and would leave the emission and OCR " +
          "endpoints accepting unverified webhooks.",
      );
    }
    if (!key) {
      throw new Error(
        "INNGEST_SIGNING_KEY is required in production — the Inngest endpoint " +
          "(real invoice emission + OCR) must verify webhook signatures.",
      );
    }
    return key;
  }

  return key || undefined;
}
