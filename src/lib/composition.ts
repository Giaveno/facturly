/**
 * Env-gated driver composition — the SINGLE discoverable place that selects which
 * backend runs, keyed by environment variables.
 *
 * Every selector has a SAFE default and REFUSES the non-default (fake/pglite/
 * test) selection under a production build. The production paths stay where they
 * always were — `src/lib/db/client.ts` (Neon `pg`), `src/lib/emission/gateway.ts`
 * (real WSAA/WSFEv1), and `src/lib/auth/session.ts` (fail-closed NextAuth seam).
 * This module only SELECTS among them (plus the offline demo/test backends). It
 * never changes production behavior; it only adds guarded escape hatches.
 *
 * Env vars (all TEST/DEMO ONLY — refused when NODE_ENV=production):
 *
 *   DATABASE_DRIVER = pg    (default) | pglite   (in-process @electric-sql/pglite)
 *   ARCA_ADAPTER    = prod  (default) | fake     (deterministic in-memory gateway)
 *   OCR_ADAPTER     = prod  (default) | fake     (prod is not wired yet — fails loud)
 *   AUTH_MODE       = real  (default) | test     (stub session)
 */

import type { Db } from "@/lib/db/types";
import type { ArcaGateway } from "@/ports/arca-gateway";
import type { OcrProvider } from "@/ports/ocr-provider";
import { ArcaGatewayFake } from "@/adapters/arca/arca-gateway.fake";
import { OcrFake } from "@/adapters/ocr/ocr.fake";
import { createPgliteDb } from "@/lib/db/pglite";
import { getDb } from "@/lib/db/client";
import { buildArcaGateway } from "@/lib/emission/gateway";
import { requireAccountantSession } from "@/lib/auth/session";

export type DatabaseDriver = "pg" | "pglite";
export type ArcaAdapterMode = "prod" | "fake";
export type OcrAdapterMode = "prod" | "fake";
export type AuthMode = "real" | "test";

/** A subset of `process.env` the selectors read (keeps them pure and testable). */
export interface Env {
  NODE_ENV?: string;
  DATABASE_DRIVER?: string;
  ARCA_ADAPTER?: string;
  OCR_ADAPTER?: string;
  AUTH_MODE?: string;
}

function isProduction(env: Env): boolean {
  return env.NODE_ENV === "production";
}

/**
 * Fail-closed production guard. A non-default (test/demo) backend must NEVER run
 * under `NODE_ENV=production` — this makes it structurally impossible to select
 * the fake stack or the test auth in a production build.
 */
function refuseNonDefaultInProduction(
  env: Env,
  varName: string,
  value: string,
  safeDefault: string,
): void {
  if (isProduction(env) && value !== safeDefault) {
    throw new Error(
      `${varName}="${value}" is TEST/DEMO ONLY and is refused in a production build ` +
        `(NODE_ENV=production). Only the safe default "${safeDefault}" is allowed.`,
    );
  }
}

/** DATABASE_DRIVER — `pg` (default, Neon) or `pglite` (offline in-process). */
export function selectDatabaseDriver(env: Env = process.env): DatabaseDriver {
  const raw = (env.DATABASE_DRIVER ?? "").trim() || "pg";
  if (raw !== "pg" && raw !== "pglite") {
    throw new Error(`DATABASE_DRIVER must be "pg" or "pglite" (got "${raw}")`);
  }
  refuseNonDefaultInProduction(env, "DATABASE_DRIVER", raw, "pg");
  return raw;
}

/** ARCA_ADAPTER — `prod` (default, real WSAA/WSFEv1) or `fake` (offline). */
export function selectArcaAdapter(env: Env = process.env): ArcaAdapterMode {
  const raw = (env.ARCA_ADAPTER ?? "").trim() || "prod";
  if (raw !== "prod" && raw !== "fake") {
    throw new Error(`ARCA_ADAPTER must be "prod" or "fake" (got "${raw}")`);
  }
  refuseNonDefaultInProduction(env, "ARCA_ADAPTER", raw, "prod");
  return raw;
}

/** OCR_ADAPTER — `prod` (default, not wired yet) or `fake` (offline). */
export function selectOcrAdapter(env: Env = process.env): OcrAdapterMode {
  const raw = (env.OCR_ADAPTER ?? "").trim() || "prod";
  if (raw !== "prod" && raw !== "fake") {
    throw new Error(`OCR_ADAPTER must be "prod" or "fake" (got "${raw}")`);
  }
  refuseNonDefaultInProduction(env, "OCR_ADAPTER", raw, "prod");
  return raw;
}

/** AUTH_MODE — `real` (default, fail-closed deny-all) or `test` (stub session). */
export function selectAuthMode(env: Env = process.env): AuthMode {
  const raw = (env.AUTH_MODE ?? "").trim() || "real";
  if (raw !== "real" && raw !== "test") {
    throw new Error(`AUTH_MODE must be "real" or "test" (got "${raw}")`);
  }
  refuseNonDefaultInProduction(env, "AUTH_MODE", raw, "real");
  return raw;
}

/** Builds the selected database. PGlite boots fresh + migrates; pg uses getDb(). */
export async function composeDb(env: Env = process.env): Promise<Db> {
  const driver = selectDatabaseDriver(env);
  if (driver === "pglite") {
    const { db } = await createPgliteDb();
    return db;
  }
  return getDb();
}

/** Builds the selected ARCA gateway. `fake` is offline; `prod` requires AES_KEY. */
export function composeArcaGateway(db: Db, env: Env = process.env): ArcaGateway {
  const mode = selectArcaAdapter(env);
  if (mode === "fake") {
    return new ArcaGatewayFake();
  }
  return buildArcaGateway(db, env as Record<string, string | undefined>);
}

/** Builds the selected OCR provider. `prod` is not wired yet → fails loudly. */
export function composeOcrProvider(env: Env = process.env): OcrProvider {
  const mode = selectOcrAdapter(env);
  if (mode === "fake") {
    return new OcrFake();
  }
  throw new Error(
    "OCR_ADAPTER=prod is selected but the production OCR adapter is not wired yet " +
      "(slice 5). Set OCR_ADAPTER=fake for the offline demo.",
  );
}

/** A session guard: asserts the caller is the authenticated accountant. */
export type AuthGuard = (request?: unknown) => void;

/** Builds the selected auth guard. `real` = fail-closed deny-all; `test` = stub. */
export function composeAuthGuard(env: Env = process.env): AuthGuard {
  const mode = selectAuthMode(env);
  if (mode === "test") {
    return () => {};
  }
  // The production seam ignores its request arg; pass a dummy for the type.
  return (request?: unknown) => requireAccountantSession(request as Request);
}
