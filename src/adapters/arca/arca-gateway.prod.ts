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
 *     number, ARCA returns 10015/10016, and the existing CAE is recovered via
 *     `FECompConsultar` — no second emission.
 *   - Duplicate detection scans BOTH `errors` and `observaciones` (ARCA surfaces
 *     the code in either channel).
 *   - Success is gated on `resultado === "A"` (a `Resultado=R` carrying a CAE is
 *     rejected, not accepted).
 *
 * Auth-retry (W5): an `ArcaAuthError` evicts the TA and retries ONCE with a
 * fresh ticket before giving up.
 */

import { createHash } from "node:crypto";
import type {
  ArcaGateway,
  FECAEReq,
  IssueInvoiceResult,
} from "@/ports/arca-gateway";
import type { CondicionIVA } from "@/domain/policy";
import { WsfeClient } from "./wsfe";
import { PadronA5Client } from "./padron";
import { TaCache, type TaCacheStore } from "./ta-cache";
import { WsaaClient, type WsaaCredentialsProvider, type WsaaTa } from "./wsaa";
import { ARCA_SERVICE_PADRON, ARCA_SERVICE_WSFE } from "./constants";
import type { HttpTransport } from "./http";
import {
  ArcaAuthError,
  ArcaBusinessError,
  classifyArcaErrorCode,
  DUPLICATE_ERROR_CODES,
} from "./errors";
import { noopLogger, noopMetrics, type ArcaLogger, type ArcaMetrics } from "./logger";
import { readEmissionsEnabled } from "./emissions";

export interface ArcaGatewayProdOptions {
  taCache: TaCache;
  wsfe: WsfeClient;
  padron: PadronA5Client;
  logger?: ArcaLogger;
  metrics?: ArcaMetrics;
  /** Master emission kill switch (default false — the safe state). */
  emissionsEnabled?: boolean;
}

export class ArcaGatewayProd implements ArcaGateway {
  private readonly taCache: TaCache;
  private readonly wsfe: WsfeClient;
  private readonly padron: PadronA5Client;
  private readonly logger: ArcaLogger;
  private readonly metrics: ArcaMetrics;
  private readonly emissionsEnabled: boolean;

  constructor(options: ArcaGatewayProdOptions) {
    this.taCache = options.taCache;
    this.wsfe = options.wsfe;
    this.padron = options.padron;
    this.logger = options.logger ?? noopLogger;
    this.metrics = options.metrics ?? noopMetrics;
    this.emissionsEnabled = options.emissionsEnabled ?? false;
  }

  async getIvaCondition(
    clientCuit: string,
    payerCuit: string,
  ): Promise<CondicionIVA | "unresolved"> {
    return this.withFreshTaOnAuth(ARCA_SERVICE_PADRON, async (ta) => {
      // cuitRepresentada = clientCuit (per call — no shared-instance downgrade),
      // idPersona = payerCuit.
      return this.padron.getPersona(ta.token, ta.sign, clientCuit, payerCuit);
    });
  }

  async issueInvoice(req: FECAEReq): Promise<IssueInvoiceResult> {
    if (!this.emissionsEnabled) {
      throw new ArcaBusinessError(
        "Emissions are disabled (EMISSIONS_ENABLED=false) — refusing to contact ARCA",
      );
    }
    // IDEMPOTENCY GUARD (slice-4 obligation, NOT enforced here):
    // The caller has already reserved `req.cbteNro` by inserting a row into
    // `issued_invoices` BEFORE calling this method. That table's unique index
    // `issued_invoices_idempotency (cuit, pto_vta, cbte_tipo, cbte_nro)` is the
    // PHYSICAL guard that makes a duplicate real emission impossible. This
    // adapter is a pure SOAP boundary and does NOT own the reservation write;
    // the emission job (slice 4, `src/jobs/emit.ts`) performs reserve→emit→
    // update-with-CAE in one transaction. This adapter only guarantees that the
    // number ARCA is asked to emit is the CALLER-PINNED `req.cbteNro` (never
    // derived from FECompUltimoAutorizado), so a retry replays the SAME number
    // and ARCA returns 10015/10016 instead of issuing a second invoice.
    return this.withFreshTaOnAuth(ARCA_SERVICE_WSFE, async (ta) => {
      return this.emit(ta, req);
    });
  }

  private async emit(ta: WsaaTa, req: FECAEReq): Promise<IssueInvoiceResult> {
    const auth = { token: ta.token, sign: ta.sign, cuit: req.cuit };
    // Caller-pinned comprobante number (design amendment #1): never derived here.
    const cbteNro = req.cbteNro;

    const result = await this.wsfe.solicitar(auth, {
      ptoVta: req.ptoVta,
      cbteTipo: req.cbteTipo,
      cbteNro,
      concepto: 1,
      docTipo: req.receptorDocTipo,
      docNro: req.receptorDocNro,
      cbteFch: req.fechaEmision,
      impNetoCentavos: req.importeNeto,
      impIvaCentavos: req.importeIva,
      impTotalCentavos: req.importeTotal,
      fchVtoPago: req.fechaVto,
      monId: req.moneda,
      monCotiz: req.cotizacion,
      iva:
        req.importeIva > 0
          ? [
              {
                id: 5,
                baseImpCentavos: req.importeNeto,
                importeCentavos: req.importeIva,
              },
            ]
          : [],
    });

    // Idempotency: scan BOTH channels — ARCA reports 10015/10016 in errors OR
    // observaciones, never assume it is only in errors.
    const duplicate = [...result.errors, ...result.observaciones].find((o) =>
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
        message: duplicate.msg,
      });
      const existing = await this.wsfe.consultarComprobante(auth, {
        ptoVta: req.ptoVta,
        cbteTipo: req.cbteTipo,
        cbteNro,
      });
      if (existing.cae !== null) {
        return {
          cae: existing.cae,
          caeFchVto: existing.caeFchVto ?? "",
          cbteNro: existing.cbteNro ?? cbteNro,
        };
      }
      throw new ArcaBusinessError(
        `Duplicate emission (${duplicate.code}) but FECompConsultar returned no CAE`,
        { code: duplicate.code },
      );
    }

    // Success is gated on `resultado === "A"` — a Resultado=R carrying a CAE is
    // still a rejection (W1).
    if (
      result.resultado !== "A" ||
      result.cae === null ||
      result.cbteNro === null
    ) {
      const first =
        result.errors[0] ?? result.observaciones[0];
      this.metrics.increment("arca_rejection");
      this.logger.error("arca_rejection", {
        cuit: req.cuit,
        ptoVta: req.ptoVta,
        cbteTipo: req.cbteTipo,
        cbteNro,
        resultado: result.resultado,
        code: first?.code,
        message: first?.msg,
      });
      if (first && classifyArcaErrorCode(first.code) === "auth") {
        throw new ArcaAuthError(
          `ARCA auth rejection (${first.code})${first.msg ? `: ${first.msg}` : ""}`,
          { code: first.code },
        );
      }
      const codes = result.errors.map((e) => e.code).join(", ");
      throw new ArcaBusinessError(
        `ARCA rejected emission (resultado=${result.resultado})${
          codes ? `, errors: ${codes}` : ""
        }`,
      );
    }

    return {
      cae: result.cae,
      caeFchVto: result.caeFchVto ?? "",
      cbteNro: result.cbteNro,
    };
  }

  /** Evicts the TA and retries ONCE when ARCA rejects the token/delegation. */
  private async withFreshTaOnAuth<T>(
    service: string,
    fn: (ta: WsaaTa) => Promise<T>,
  ): Promise<T> {
    let ta = await this.taCache.get(service);
    try {
      return await fn(ta);
    } catch (err) {
      if (err instanceof ArcaAuthError) {
        this.metrics.increment("ta_evicted_auth");
        this.logger.warn("ta_auth_rejected_retry", {
          service,
          code: err.code,
          message: err.message,
        });
        await this.taCache.evict(service);
        ta = await this.taCache.get(service);
        return await fn(ta);
      }
      throw err;
    }
  }
}

export interface ArcaGatewayProdConfig {
  /**
   * The accountant's credential source. Either the static PEM pair (dev) or a
   * provider that decrypts the private key just-in-time from the `credentials`
   * table (production — no plaintext key in config).
   */
  credentials: WsaaCredentialsProvider;
  /** Cert fingerprint / credential id scoping the TA cache (computed when a static cert is given). */
  credentialScope?: string;
  wsaaUrl: string;
  wsfeUrl: string;
  padronUrl: string;
  transport: HttpTransport;
  taStore: TaCacheStore;
  logger?: ArcaLogger;
  metrics?: ArcaMetrics;
  emissionsEnabled?: boolean;
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
  const clock = config.clock ?? (() => new Date());
  const logger = config.logger ?? noopLogger;
  const metrics = config.metrics ?? noopMetrics;

  // Cert-scoped cache key: compute from a static cert, or use the caller scope.
  const scope =
    config.credentialScope ??
    (typeof config.credentials === "object" && "certPem" in config.credentials
      ? certFingerprint(config.credentials.certPem)
      : undefined);

  const wsaa = new WsaaClient({
    url: config.wsaaUrl,
    credentials: config.credentials,
    transport: config.transport,
    clock,
    logger,
    metrics,
  });
  const taCache = new TaCache({
    wsaa,
    store: config.taStore,
    clock,
    scope,
    logger,
    metrics,
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
    emissionsEnabled: config.emissionsEnabled ?? readEmissionsEnabled(),
  });
}
