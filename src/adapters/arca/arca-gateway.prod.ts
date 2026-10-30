import { tracePhase } from "@/lib/emission/trace";
/**
 * Production `ArcaGateway` — composes WSAA (TA) + WSFEv1 (emission) + Padrón A5
 * (IVA condition) behind the existing port. Swappable with `ArcaGatewayFake`.
 *
 * Delegation model (design #2, #12):
 *   - ONE WSAA TA per service, obtained with the accountant's certificate.
 *   - WSFEv1 `Auth.Cuit` = the CLIENT company CUIT (delegation authorizes wsfe).
 *   - Padrón A5 `cuitRepresentada` = the delegating client CUIT (per call now).
 *
 * Idempotency (design amendment #1):
 *   - The caller pins `req.cbteNro` (a persisted reservation). The gateway does
 *     NOT derive it from FECompUltimoAutorizado. A retry replays the SAME
 *     number, ARCA may return a 10016 number/date conflict; a prior CAE is accepted only via
 *     `FECompConsultar` — no second emission.
 *   - Number-conflict lookup scans BOTH `errors` and `observaciones`. A code
 *     alone never proves prior authorization.
 *   - Success is gated on `resultado === "A"` (a `Resultado=R` carrying a CAE is
 *     rejected, not accepted).
 *
 * Queries and issuance never evict authentication tickets or retry automatically.
 */

import { createHash } from "node:crypto";
import type {
  ArcaGateway,
  FECAEReq,
  IssueInvoiceResult,
} from "@/ports/arca-gateway";
import type { CondicionIVA } from "@/domain/policy";
import { WsfeClient, fecaReqToSolicitar } from "./wsfe";
import { PadronA5Client } from "./padron";
import { type TaCache, type TaCacheStore } from "./ta-cache";
import { type WsaaCredentialsProvider, type WsaaTa } from "./wsaa";
import { createCredentialTaCache } from "./credential-ta-cache";
import { ARCA_SERVICE_PADRON, ARCA_SERVICE_WSFE } from "./constants";
import type { HttpTransport } from "./http";
import {
  ArcaAuthError,
  ArcaBusinessError,
  classifyArcaErrorCode,
  DUPLICATE_ERROR_CODES,
} from "./errors";
import { createConsoleLogger, noopLogger, noopMetrics, type ArcaLogger, type ArcaMetrics } from "./logger";
import { assertEmissionConfiguration, readEmissionsEnabled } from "./emissions";
import { resolveArcaEnvironment } from "@/lib/emission/environment";
import { ArcaQueryError } from "./query-diagnostics";

export interface ArcaGatewayProdOptions {
  taCache: Pick<TaCache, "get" | "evict">;
  wsfe: WsfeClient;
  padron: PadronA5Client;
  logger?: ArcaLogger;
  metrics?: ArcaMetrics;
  /** Master emission kill switch (default false — the safe state). */
  emissionsEnabled?: boolean;
  env?: Record<string, string | undefined>;
  environment?: "production" | "homologacion";
}

export class ArcaGatewayProd implements ArcaGateway {
  private readonly taCache: Pick<TaCache, "get" | "evict">;
  private readonly wsfe: WsfeClient;
  private readonly padron: PadronA5Client;
  private readonly logger: ArcaLogger;
  private readonly metrics: ArcaMetrics;
  private readonly emissionsEnabled: boolean;
  private readonly environment: "production" | "homologacion";

  constructor(options: ArcaGatewayProdOptions) {
    const emissionsEnabled = options.emissionsEnabled ?? false;
    if (emissionsEnabled) {
      if (options.environment === "production") {
        // Explicit production construction must fail closed before any
        // gateway operation. Keep the dedicated configuration error/message.
        assertEmissionConfiguration({
          EMISSIONS_ENABLED: "true",
          ARCA_ENV: options.environment,
        });
      } else if (options.env) {
        assertEmissionConfiguration(options.env);
      }
    }
    this.taCache = options.taCache;
    this.wsfe = options.wsfe;
    this.padron = options.padron;
    this.logger = options.logger ?? noopLogger;
    this.metrics = options.metrics ?? noopMetrics;
    this.emissionsEnabled = emissionsEnabled;
    this.environment = options.environment ?? "homologacion";
  }

  async getIvaCondition(
    clientCuit: string,
    payerCuit: string,
  ): Promise<CondicionIVA | "unresolved"> {
    return this.withTa(ARCA_SERVICE_PADRON, async (ta) => {
      // cuitRepresentada = clientCuit (per call — no shared-instance downgrade),
      // idPersona = payerCuit.
      return this.padron.getPersona(ta.token, ta.sign, clientCuit, payerCuit);
    });
  }

  async ultimoAutorizado(
    cuit: string,
    ptoVta: number,
    cbteTipo: number,
  ): Promise<number> {
    return this.withTa(ARCA_SERVICE_WSFE, async (ta) => {
      return this.wsfe.ultimoAutorizado(
        { token: ta.token, sign: ta.sign, cuit },
        { ptoVta, cbteTipo },
      );
    });
  }

  async issueInvoice(req: FECAEReq, beforeDispatch?: () => Promise<void>, onDispatched?: () => void): Promise<IssueInvoiceResult> {
    if (!this.emissionsEnabled) assertEmissionConfiguration({ EMISSIONS_ENABLED: "false", ARCA_ENV: this.environment });
    if (this.environment !== "homologacion") assertEmissionConfiguration({ EMISSIONS_ENABLED: "true", ARCA_ENV: this.environment });
    // The caller owns a durable environment/series claim and reservation.
    // A unique row alone does not serialize dispatch of an existing reservation.
    // An issuance is never retried, even after an authentication error.
    const ta = await this.taCache.get(ARCA_SERVICE_WSFE);
    tracePhase("preparation");
    return this.emit(ta, req, beforeDispatch, onDispatched);
  }

  async consultInvoice(req: FECAEReq): Promise<IssueInvoiceResult | null> {
    const ta = await this.taCache.get(ARCA_SERVICE_WSFE);
    return this.consultWithTa(ta, req);
  }

  private async consultWithTa(ta: WsaaTa, req: FECAEReq): Promise<IssueInvoiceResult | null> {
    const auth = {token:ta.token,sign:ta.sign,cuit:req.cuit}, cbteNro=req.cbteNro;
    let existing;
    try { existing = await this.wsfe.consultarComprobante(auth, {ptoVta:req.ptoVta,cbteTipo:req.cbteTipo,cbteNro}); }
    catch (error) {
      if (error instanceof ArcaQueryError && error.diagnostic.category === "provider-errors" && error.diagnostic.providerCodes?.length === 1 && error.diagnostic.providerCodes[0] === 602) return null;
      if (error instanceof ArcaQueryError) throw new ArcaBusinessError("ARCA issuance outcome uncertain; read-only verification required", {stage:"issuance",category:error.diagnostic.category,providerCodes:error.diagnostic.providerCodes,httpStatus:error.diagnostic.httpStatus});
      throw error;
    }
      if (existing.resultado === "A" && existing.emissionType === "CAE" && existing.cae !== null && existing.caeFchVto !== null &&
        existing.cbteNro === cbteNro && existing.ptoVta === req.ptoVta && existing.cbteTipo === req.cbteTipo &&
        existing.impTotalCentavos === req.importeTotal && existing.impNetoCentavos === req.importeNeto && existing.impIvaCentavos === req.importeIva &&
        existing.moneda === req.moneda && existing.cotizacion === req.cotizacion && existing.docTipo === req.receptorDocTipo &&
        existing.docNro === req.receptorDocNro && existing.fechaEmision === req.fechaEmision.replaceAll("-", "") &&
        (existing.condicionIvaReceptorId == null || existing.condicionIvaReceptorId === req.condicionIvaReceptorId) &&
        (existing.concepto == null || existing.concepto === 1) &&
        [existing.impTotConcCentavos, existing.impOpExCentavos, existing.impTribCentavos].every(value => value == null || value === 0)) {
        return {
          cae: existing.cae,
          caeFchVto: existing.caeFchVto,
          cbteNro: existing.cbteNro,
        };
      }
    throw new ArcaBusinessError("El comprobante existe en ARCA, pero sus datos no coinciden con la reserva local.", { stage: "issuance", category: "malformed-response" });
  }

  private async emit(ta: WsaaTa, req: FECAEReq, beforeDispatch?: () => Promise<void>, onDispatched?: () => void): Promise<IssueInvoiceResult> {
    const auth = { token: ta.token, sign: ta.sign, cuit: req.cuit };
    // Caller-pinned comprobante number (design amendment #1): never derived here.
    const cbteNro = req.cbteNro;

    const payload = fecaReqToSolicitar(req);
    // TA acquisition may outlive the lease; do not rely on the caller's earlier check.
    const result = await this.wsfe.solicitar(auth, payload, beforeDispatch, onDispatched);

    // Idempotency: scan BOTH channels — ARCA reports 10015/10016 in errors OR
    // observaciones, never assume it is only in errors.
    const blockingError = result.errors.find(o => !DUPLICATE_ERROR_CODES.has(o.code) && classifyArcaErrorCode(o.code) === "business");
    const duplicate = !blockingError && [...result.errors, ...result.observaciones].find((o) =>
      DUPLICATE_ERROR_CODES.has(o.code),
    );
    if (duplicate) {
      this.metrics.increment("arca_duplicate");
      this.logger.warn("arca_duplicate", {
        cuit: req.cuit,
        ptoVta: req.ptoVta,
        cbteTipo: req.cbteTipo,
        cbteNro,
        code: duplicate.code,
      });
      const recovered = await this.consultWithTa(ta,req);
      if (recovered) return recovered;
      throw new ArcaBusinessError(
        "ARCA issuance outcome uncertain; consulted fiscal evidence did not match",
        { code: duplicate.code, stage: "issuance", category: "malformed-response", providerCodes: [Number(duplicate.code)] },
      );
    }

    // Success is gated on `resultado === "A"` — a Resultado=R carrying a CAE is
    // still a rejection (W1).
    if (
      result.resultado !== "A" ||
      result.cae === null ||
      result.cbteNro === null
    ) {
      const first = blockingError ?? result.errors[0] ?? result.observaciones[0];
      const code = first && /^\d{1,9}$/.test(first.code) ? first.code : undefined;
      const providerCodes = [...result.errors, ...result.observaciones].filter(o => /^\d{1,9}$/.test(o.code)).slice(0, 10).map(o => Number(o.code));
      const resultado = ["A", "R", "P"].includes(result.resultado) ? result.resultado : "unknown";
      this.metrics.increment("arca_rejection");
      this.logger.error("arca_rejection", {
        cuit: req.cuit,
        ptoVta: req.ptoVta,
        cbteTipo: req.cbteTipo,
        cbteNro,
        resultado,
        code,
      });
      if (first && classifyArcaErrorCode(first.code) === "auth") {
        throw new ArcaAuthError(
          `ARCA auth rejection (${first.code})`,
          { code: first.code, stage: "issuance", category: "provider-errors", providerCodes },
        );
      }
      throw new ArcaBusinessError(
        `ARCA rejected emission (resultado=${resultado})${code ? `, code=${code}` : ""}`,
        { code, stage: "issuance", category: "provider-errors", providerCodes },
      );
    }

    return {
      cae: result.cae,
      caeFchVto: result.caeFchVto ?? "",
      cbteNro: result.cbteNro,
    };
  }

  /** Authentication failures preserve the durable ticket; never evict and retry. */
  private async withTa<T>(service: string, fn: (ta: WsaaTa) => Promise<T>): Promise<T> {
    return fn(await this.taCache.get(service));
  }

}

export interface ArcaGatewayProdConfig {
  /**
   * The accountant's credential source. Either the static PEM pair (dev) or a
   * provider that decrypts the private key just-in-time from the `credentials`
   * table (production — no plaintext key in config).
   */
  credentials: WsaaCredentialsProvider;
  /** Optional additional namespace; certificate and endpoint scoping are always enforced. */
  credentialScope?: string;
  wsaaUrl: string;
  wsfeUrl: string;
  padronUrl: string;
  transport: HttpTransport;
  taStore: TaCacheStore;
  logger?: ArcaLogger;
  metrics?: ArcaMetrics;
  emissionsEnabled?: boolean;
  env?: Record<string, string | undefined>;
  clock?: () => Date;
}

/** SHA-256 fingerprint of a cert PEM, scoping the TA cache per credential. */
export function certFingerprint(certPem: string): string {
  return createHash("sha256").update(certPem).digest("hex").slice(0, 16);
}

/**
 * Builds a production `ArcaGateway` from raw config (endpoints, credentials,
 * transport, cache store). The fake adapter is constructed directly.
 */
export function createArcaGatewayProd(
  config: ArcaGatewayProdConfig,
): ArcaGateway {
  const env = config.env ?? process.env;
  assertEmissionConfiguration(env);
  const clock = config.clock ?? (() => new Date());
  const logger = config.logger ?? createConsoleLogger();
  const metrics = config.metrics ?? noopMetrics;

  // Resolve dynamic providers before selecting a certificate + endpoint cache.
  // The diagnostic uses these exact keys, so a successful LoginCms is reused.
  const taCache = createCredentialTaCache({
    url: config.wsaaUrl,
    credentials: config.credentials,
    transport: config.transport,
    clock,
    logger,
    metrics,
    store: config.taStore,
    scope: config.credentialScope,
  });
  const wsfe = new WsfeClient({
    url: config.wsfeUrl,
    transport: config.transport,
  });
  const padron = new PadronA5Client({
    url: config.padronUrl,
    transport: config.transport,
  });
  return new ArcaGatewayProd({
    taCache,
    wsfe,
    padron,
    logger,
    metrics,
    // Derive environment only from validated configuration, never from an
    // endpoint or the caller's `emissionsEnabled` override.
    emissionsEnabled: config.emissionsEnabled ?? readEmissionsEnabled(env),
    environment: resolveArcaEnvironment(env),
    env,
  });
}
