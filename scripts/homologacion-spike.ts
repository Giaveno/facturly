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
 *   ARCA_ENV                 homologacion | production (default: homologacion)
 *   ARCA_CONFIRM_PRODUCTION  must be "yes" to run against production (safety)
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
 *             3 = network/timeout (transient — retry).
 */

import { readFileSync } from "node:fs";
import { WsaaClient } from "../src/adapters/arca/wsaa";
import {
  WsfeClient,
  type FecaesolicitarRequest,
} from "../src/adapters/arca/wsfe";
import { evaluateEmissionResult } from "../src/adapters/arca/homologacion";
import { createFetchTransport } from "../src/adapters/arca/http";
import { ArcaTransientError } from "../src/adapters/arca/errors";
import {
  WSAA_HOMOLOGACION_URL,
  WSAA_PRODUCTION_URL,
  WSFE_HOMOLOGACION_URL,
  WSFE_PRODUCTION_URL,
  type ArcaEnvironment,
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

async function main(): Promise<void> {
  const envName = env("ARCA_ENV") ?? "homologacion";
  if (envName !== "homologacion" && envName !== "production") {
    failMisconfigured(`ARCA_ENV must be "homologacion" or "production" (got "${envName}")`);
  }
  const arcaEnv: ArcaEnvironment = envName;

  if (arcaEnv === "production" && env("ARCA_CONFIRM_PRODUCTION") !== "yes") {
    failMisconfigured(
      "Refusing to run against PRODUCTION without explicit confirmation. This " +
        "emits a REAL fiscal comprobante. Set ARCA_CONFIRM_PRODUCTION=yes to proceed.",
    );
  }

  const clientCuit = env("ARCA_CLIENT_CUIT");
  if (!clientCuit) {
    failMisconfigured(
      "ARCA_CLIENT_CUIT is required — the delegated CLIENT CUIT whose wsfe " +
        "delegation this gate validates.",
    );
  }

  const certPem = loadCertPem();
  const keyPem = loadKeyPem();

  const ptoVta = Number(env("ARCA_PTO_VTA") ?? "1");
  const cbteTipo = Number(env("ARCA_CBTE_TIPO") ?? "6");

  const wsaaUrl =
    arcaEnv === "production" ? WSAA_PRODUCTION_URL : WSAA_HOMOLOGACION_URL;
  const wsfeUrl =
    arcaEnv === "production" ? WSFE_PRODUCTION_URL : WSFE_HOMOLOGACION_URL;
  // 20s per-call timeout so a hung ARCA call cannot pin the harness forever.
  const transport = createFetchTransport({ timeoutMs: 20_000 });

  console.log(`\nHOMOLOGACIÓN GATE — environment: ${arcaEnv}`);
  console.log(`  WSAA:  ${wsaaUrl}`);
  console.log(`  WSFEv1: ${wsfeUrl}`);
  console.log(`  Client CUIT: ${clientCuit}  PtoVta: ${ptoVta}  CbteTipo: ${cbteTipo}\n`);

  // 1. Obtain ONE TA with the accountant's certificate (wsfe service).
  console.log("[1/3] WSAA LoginCms (wsfe) with the accountant's certificate…");
  const wsaa = new WsaaClient({
    url: wsaaUrl,
    credentials: { certPem, keyPem },
    transport,
  });
  const ta = await wsaa.loginCms("wsfe");
  console.log("      TA obtained (token/sign held in memory, never printed).");

  // 2. Determine the next comprobante number.
  const wsfe = new WsfeClient({ url: wsfeUrl, transport });
  const auth = { token: ta.token, sign: ta.sign, cuit: clientCuit };
  const lastNro = await wsfe.ultimoAutorizado(auth, { ptoVta, cbteTipo });
  const cbteNro = lastNro + 1;
  console.log(`[2/3] FECompUltimoAutorizado → last ${lastNro}, next ${cbteNro}.`);

  // 3. Emit a minimal Factura B to consumidor final (Auth.Cuit = client CUIT).
  const req: FecaesolicitarRequest = {
    ptoVta,
    cbteTipo,
    cbteNro,
    concepto: 1,
    docTipo: 99, // consumidor final
    docNro: 0,
    cbteFch: new Date().toISOString().slice(0, 10),
    impNetoCentavos: 100,
    impIvaCentavos: 0,
    impTotalCentavos: 100,
    fchVtoPago: new Date().toISOString().slice(0, 10),
    monId: "PES",
    monCotiz: 1,
    iva: [],
  };
  console.log("[3/3] FECAESolicitar with Auth.Cuit = <client CUIT>…");
  const result = await wsfe.solicitar(auth, req);

  const verdict = evaluateEmissionResult(result);
  console.log(`\n${verdict.passed ? "✓ PASS" : "✗ FAIL"} — ${verdict.criterion}`);
  console.log(`  ${verdict.detail}\n`);

  process.exit(verdict.passed ? 0 : 1);
}

main().catch((err) => {
  if (err instanceof ArcaTransientError) {
    console.error(`\n✗ TRANSIENT — network/timeout: ${err.message}\n`);
    process.exit(3);
  }
  console.error(
    `\n✗ FAIL — unexpected error: ${err instanceof Error ? err.message : err}\n`,
  );
  process.exit(1);
});
