import { arcaTimeouts } from "@/adapters/arca/timeouts";
/**
 * Production `ArcaGateway` composition — the piece that wires the WSAA/WSFEv1
 * adapters (slice 3) to real endpoints, credentials, and a DB-backed TA cache.
 *
 * This is a THIN, non-offline composition: it requires a provisioned
 * `credentials` row (AES_KEY) plus network to ARCA, so it is NOT exercised in
 * the offline test suite. Its behavior is guaranteed by the adapters' own unit
 * tests and the emission service's integration tests against the fake gateway.
 */

import {
  createArcaGatewayProd,
} from "@/adapters/arca/arca-gateway.prod";
import { createFetchTransport } from "@/adapters/arca/http";
import {
  PADRON_HOMOLOGACION_URL,
  PADRON_PRODUCTION_URL,
  WSAA_HOMOLOGACION_URL,
  WSAA_PRODUCTION_URL,
  WSFE_HOMOLOGACION_URL,
  WSFE_PRODUCTION_URL,
} from "@/adapters/arca/constants";
import {
  DrizzleCredentialsRepository,
  credentialsProvider,
} from "@/lib/db/credentials-repository";
import { DrizzleTaCacheStore } from "@/lib/db/ta-cache-store";
import { resolveArcaEnvironment } from "./environment";
import { readEmissionsEnabled } from "@/adapters/arca/emissions";
import {
  createConsoleLogger,
  createInMemoryMetrics,
} from "@/adapters/arca/logger";
import type { ArcaGateway } from "@/ports/arca-gateway";
import type { Db } from "@/lib/db/types";

/**
 * Builds the production `ArcaGateway` from environment + the DB. Fails loudly
 * when `AES_KEY` is missing (never falls back to a plaintext key).
 */
export function buildArcaGateway(
  db: Db,
  env: Record<string, string | undefined> = process.env,
): ArcaGateway {
  const arcaEnv = resolveArcaEnvironment(env);
  const aesKey = env.AES_KEY ?? "";
  if (aesKey.trim() === "") {
    throw new Error("AES_KEY is not set — cannot decrypt the ARCA private key");
  }

  // C5: real observability, not `noop`. The JSON logger emits the slice-3
  // signals (arca_rejection / arca_duplicate / arca_timeout / wsaa_login_failed
  // / ta_evicted_auth) to stdout/stderr. Metrics is an in-memory collector — a
  // placeholder until a durable sink is wired (serverless invocations do not
  // persist in-memory counters). Never token/sign/private-key material.
  const logger = createConsoleLogger();
  const metrics = createInMemoryMetrics();

  return createArcaGatewayProd({
    credentials: credentialsProvider(
      new DrizzleCredentialsRepository(db),
      aesKey,
    ),
    wsaaUrl: arcaEnv === "production" ? WSAA_PRODUCTION_URL : WSAA_HOMOLOGACION_URL,
    wsfeUrl: arcaEnv === "production" ? WSFE_PRODUCTION_URL : WSFE_HOMOLOGACION_URL,
    padronUrl:
      arcaEnv === "production" ? PADRON_PRODUCTION_URL : PADRON_HOMOLOGACION_URL,
    transport: createFetchTransport({ logger, metrics, timeoutMs: arcaTimeouts(arcaEnv).callMs }),
    taStore: new DrizzleTaCacheStore(db),
    emissionsEnabled: readEmissionsEnabled(env),
    logger,
    metrics,
  });
}
