/**
 * HOMOLOGACIÓN GATE — manual pre-apply spike (NOT a CI test).
 *
 * Validates the delegation model against ARCA's homologación (test) environment:
 *
 *   Criterion: `FECAESolicitar` with `Auth.Cuit = <client CUIT>` returns
 *   `Resultado = A`, using ONE TA obtained with the accountant's certificate.
 *
 *   PASS → the one-TA delegation model holds.
 *   FAIL → fall back to the per-client WSAA TA model (one TA per client CUIT).
 *
 * This needs a REAL X.509 certificate and network, so a human runs it:
 *
 *   pnpm homologacion:spike
 *
 * Prerequisites (MANUAL LEAD TIME — the accountant must obtain these first):
 *   1. An X.509 certificate on the accountant's CUIT (Clave Fiscal → Administrador
 *      de Relaciones → "Administración de certificados").
 *   2. Each client delegating the `wsfe` service to the accountant's CUIT
 *      (Administrador de Relaciones → "Nuevo servicio" → wsfe).
 *   3. Each client's Punto de Venta habilitated for `wsfe` (ABM Puntos de Venta).
 *
 * Environment variables (see .env.example for the full list):
 *   ARCA_ENV                 must be homologacion (default: homologacion)
 *   DATABASE_URL             same Neon database as the app (REQUIRED)
 *   ARCA_CERT_PEM            X.509 certificate PEM inline   (or ARCA_CERT_FILE)
 *   ARCA_KEY_FILE            private key PEM FILE PATH (REQUIRED — never inline)
 *   ARCA_CLIENT_CUIT         the delegated CLIENT CUIT (REQUIRED)
 *   ARCA_PTO_VTA             punto de venta (default: 1)
 *   ARCA_CBTE_TIPO           comprobante tipo (default: 6 = Factura B to CF)
 *
 * ⚠️ This emits a REAL fiscal comprobante against the selected environment and
 *   consumes a comprobante number EVERY run. Use a DEDICATED Punto de Venta.
 *
 * SECURITY: tokens, signs, and private keys are never logged. The private key is
 * read into memory only and is accepted as a FILE PATH, never an env var (env
 * vars leak via process listings, child processes, crash dumps, and CI logs).
 *
 * Exit codes: 0 = PASS, 1 = criterion FAIL, 2 = missing creds/misconfigured,
 *             3 = network/timeout (uncertain — do not blindly retry).
 */

import { readFileSync } from "node:fs";
import { createCredentialTaCache } from "../src/adapters/arca/credential-ta-cache";
import { DrizzleTaCacheStore } from "../src/lib/db/ta-cache-store";
import { getDb } from "../src/lib/db/client";
import {
  WsfeClient,
  type FecaesolicitarRequest,
} from "../src/adapters/arca/wsfe";
import { evaluateEmissionResult } from "../src/adapters/arca/homologacion";
import { createFetchTransport } from "../src/adapters/arca/http";
import { ArcaTransientError } from "../src/adapters/arca/errors";
import {
  WSAA_HOMOLOGACION_URL,
  WSFE_HOMOLOGACION_URL,
} from "../src/adapters/arca/constants";

function failMisconfigured(message: string): never {
  console.error(`\n✗ MISCONFIGURED — ${message}\n`);
  process.exit(2);
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v : undefined;
}

/** Loads the CERTIFICATE PEM (inline or file path — it is public). */
function loadCertPem(): string {
  const inline = env("ARCA_CERT_PEM");
  if (inline) return inline;
  const filePath = env("ARCA_CERT_FILE");
  if (!filePath) {
    failMisconfigured(
      "Certificate missing: set ARCA_CERT_PEM (inline PEM) or ARCA_CERT_FILE (path).",
    );
  }
  return readFileSync(filePath, "utf8");
}

/** Loads the PRIVATE KEY from a FILE PATH only — inline env keys are forbidden. */
function loadKeyPem(): string {
  const filePath = env("ARCA_KEY_FILE");
  if (!filePath) {
    failMisconfigured(
      "Private key missing: set ARCA_KEY_FILE (a filesystem path). Inline keys " +
        "via env vars are NOT supported — env vars leak via process listings, " +
        "child processes, crash dumps, and CI logs.",
    );
  }
  return readFileSync(filePath, "utf8");
}

async function main() {
  throw new Error("Diagnostic issuance retired; use the normal application emission service");
}

main().catch((err) => {
  if (err instanceof ArcaTransientError) {
    console.error("\n✗ TRANSIENT — network/timeout; outcome may be uncertain. Do not blindly retry.\n");
    process.exit(3);
  }
  console.error(
    "\n✗ FAIL — diagnostic stopped safely; no automatic retry.\n",
  );
  process.exit(1);
});
