import { tracePhase, withPhase } from "@/lib/emission/trace";
/**
 * WSAA TA (Token+Sign) cache, keyed by ARCA service (optionally scoped by the
 * signing certificate so a TA signed by a rotated/revoked cert is never reused).
 *
 * Two services use WSAA: `wsfe` (emission) and `ws_sr_constancia_inscripcion`
 * (Padrón A5). They are SEPARATE services and MUST be cached independently.
 *
 * Renewal is derived from the TA's own `expirationTime` (NOT a hardcoded 12h
 * TTL) minus a safety margin, and gated by a cooldown so we never hammer WSAA.
 *
 * Persistence decision: the cache is DB-backed (`ta_cache` table), NOT process
 * memory. This app is Next.js on serverless — an in-memory cache does NOT
 * survive across invocations, so a Map alone would re-request a TA on every
 * cold start and waste ARCA rate budget.
 *
 * Reliability fixes:
 *   - CERT SCOPING: a `scope` (cert fingerprint / credential id) is folded into
 *     the cache key, so a rotated cert never reuses a stale TA.
 *   - SINGLE-FLIGHT: concurrent cold-cache requests share one `loginCms` call
 *     (in-process mutex) instead of each calling WSAA and tripping the cooldown.
 *   - A successful `loginCms` is NEVER thrown away when `store.put` fails — the
 *     valid TA is returned and the cache-write failure is logged.
 */

import { createHash } from "node:crypto";
import { safeQueryDiagnostic } from "./query-diagnostics";
import type { WsaaTa } from "./wsaa";
import { createConsoleLogger, noopMetrics, type ArcaLogger, type ArcaMetrics } from "./logger";

/** A cached TA entry (epoch-millisecond timestamps). */
export interface TaCacheEntry {
  token: string;
  sign: string;
  /** TA expiry, epoch ms (derived from the TA's own expirationTime). */
  expiresAt: number;
  /** When this TA was issued/renewed, epoch ms. */
  issuedAt: number;
}

/** Renewal policy (safety margin + cooldown). */
export interface TaRenewalPolicy {
  /** Renew this far before expiry to absorb clock skew + request latency. */
  marginMs: number;
  /** Minimum interval between renewal attempts (WSAA cooldown). */
  cooldownMs: number;
}

/**
 * Defaults. The TA is valid 12h; renew 5 minutes before expiry so a request in
 * flight never sees an already-expired token. Cooldown of 2 minutes prevents
 * hammering WSAA (which rejects too-frequent LoginCms for the same service).
 */
export const DEFAULT_TA_POLICY: TaRenewalPolicy = {
  marginMs: 5 * 60 * 1000,
  cooldownMs: 2 * 60 * 1000,
};

/** Minimal WSAA provider the cache needs (production: `WsaaClient.loginCms`). */
export interface WsaaProvider {
  loginCms(service: string): Promise<WsaaTa>;
}

/** Persistence for TA entries (production: Drizzle `ta_cache` table). */
export interface TaCacheStore {
  get(key: string): Promise<TaCacheEntry | null>;
  put(key: string, entry: TaCacheEntry): Promise<void>;
  /** Removes a cached entry (used to evict a TA ARCA has rejected). */
  delete?(key: string): Promise<void>;
}

/**
 * Pure renewal decision. Returns true when a new TA should be requested:
 *
 *   - expired  → always renew;
 *   - comfortable (now < expiresAt - margin) → reuse;
 *   - within margin → renew only when the cooldown has elapsed.
 */
export function shouldRenew(
  nowMs: number,
  entry: TaCacheEntry,
  policy: TaRenewalPolicy,
): boolean {
  if (nowMs >= entry.expiresAt) return true;
  if (nowMs < entry.expiresAt - policy.marginMs) return false;
  return nowMs - entry.issuedAt >= policy.cooldownMs;
}

/** Parses an ARCA `expirationTime` (ISO with `-03:00`) into epoch ms. */
export function parseWsaaExpiration(expirationTime: string): number {
  const ms = Date.parse(expirationTime);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid WSAA expirationTime "${expirationTime}"`);
  }
  return ms;
}

export interface TaCacheOptions {
  wsaa: WsaaProvider;
  store: TaCacheStore;
  policy?: Partial<TaRenewalPolicy>;
  clock?: () => Date;
  /** Cert fingerprint / credential id folded into the cache key. */
  scope?: string;
  logger?: ArcaLogger;
  metrics?: ArcaMetrics;
}

/** TA cache with DB persistence, margin-based renewal, cooldown, single-flight. */
export class TaCache {
  private readonly wsaa: WsaaProvider;
  private readonly store: TaCacheStore;
  private readonly policy: TaRenewalPolicy;
  private readonly clock: () => Date;
  private readonly scope: string;
  private readonly logger: ArcaLogger;
  private readonly metrics: ArcaMetrics;
  /** In-flight renewals keyed by cache key (single-flight). */
  private readonly inflight = new Map<string, Promise<WsaaTa>>();

  constructor(options: TaCacheOptions) {
    this.wsaa = options.wsaa;
    this.store = options.store;
    this.policy = { ...DEFAULT_TA_POLICY, ...options.policy };
    this.clock = options.clock ?? (() => new Date());
    this.scope = options.scope ?? "";
    this.logger = options.logger ?? createConsoleLogger();
    this.metrics = options.metrics ?? noopMetrics;
  }

  /** The cache key for a service, scoped by the signing certificate. */
  private keyFor(service: string): string {
    return this.scope ? `${this.scope}:${service}` : service;
  }

  /** Returns a valid TA for `service`, renewing only when necessary. */
  async get(service: string): Promise<WsaaTa> {
    return withPhase("wsaa", () => this.getInner(service));
  }

  private async getInner(service: string): Promise<WsaaTa> {
    const key = this.keyFor(service);
    const nowMs = this.clock().getTime();
    const entry = await this.store.get(key);
    this.logger.info("ta_cache_lookup", { service, cache_key_hash: createHash("sha256").update(key).digest("hex").slice(0, 12), cache: entry ? "hit" : "miss" });

    if (entry && !shouldRenew(nowMs, entry, this.policy)) {
      tracePhase("wsaa", { service, cache: "hit", login: "cached" });
      return this.toTa(entry);
    }

    // Single-flight: reuse an in-flight renewal for this key.
    const inFlight = this.inflight.get(key);
    if (inFlight) {
      this.metrics.increment("ta_singleflight_reuse");
      return inFlight;
    }

    const renewal = this.renew(key, service, entry, nowMs);
    this.inflight.set(key, renewal);
    try {
      return await renewal;
    } finally {
      this.inflight.delete(key);
    }
  }

  /** Evicts a cached TA (e.g. after ARCA rejects the token). */
  async evict(service: string): Promise<void> {
    const key = this.keyFor(service);
    if (this.store.delete) {
      await this.store.delete(key);
    }
  }

  private async renew(
    key: string,
    service: string,
    entry: TaCacheEntry | null,
    nowMs: number,
  ): Promise<WsaaTa> {
    let ta: WsaaTa;
    try {
      tracePhase("wsaa", { service, cache: entry ? "expired" : "miss", login: "started" });
      ta = await this.wsaa.loginCms(service);
      tracePhase("wsaa", { service, login: "succeeded" });
    } catch (err) {
      // A genuine loginCms failure: fall back to a still-valid cached TA (this
      // is the WSAA-cooldown path), otherwise rethrow.
      this.metrics.increment("wsaa_failure");
      const diagnostic = safeQueryDiagnostic(err && typeof err === "object" && "diagnostic" in err ? err.diagnostic : undefined);
      this.logger.warn("wsaa_login_failed", {
        service, cache_key_hash: createHash("sha256").update(key).digest("hex").slice(0, 12), cache: entry ? "hit" : "miss",
        faultcode: diagnostic?.faultcode, faultstring: diagnostic?.faultstring,
      });
      if (entry && nowMs < entry.expiresAt) {
        this.metrics.increment("wsaa_cooldown");
        this.logger.warn("ta_cooldown_hit", { service });
        return this.toTa(entry);
      }
      throw err;
    }

    // loginCms SUCCEEDED — a cache-write failure must not discard the TA.
    const entryToStore: TaCacheEntry = {
      token: ta.token,
      sign: ta.sign,
      expiresAt: parseWsaaExpiration(ta.expirationTime),
      issuedAt: nowMs,
    };
    try {
      await this.store.put(key, entryToStore);
    } catch {
      this.metrics.increment("ta_cache_write_failed");
      this.logger.error("ta_cache_write_failed", {
        service, cache_key_hash: createHash("sha256").update(key).digest("hex").slice(0, 12), reason: "store-put-failed",
      });
    }
    this.metrics.increment("ta_renewed");
    return ta;
  }

  private toTa(entry: TaCacheEntry): WsaaTa {
    return {
      token: entry.token,
      sign: entry.sign,
      expirationTime: new Date(entry.expiresAt).toISOString(),
    };
  }
}
