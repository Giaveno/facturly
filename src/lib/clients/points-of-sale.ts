import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { ARCA_SERVICE_WSFE, WSAA_HOMOLOGACION_URL, WSFE_HOMOLOGACION_URL } from "@/adapters/arca/constants";
import { createCredentialTaCache } from "@/adapters/arca/credential-ta-cache";
import type { TaCacheStore } from "@/adapters/arca/ta-cache";
import { WsfeClient, parseFeParamGetPtosVentaResponse, type PointOfSale } from "@/adapters/arca/wsfe";
import { ArcaQueryError, safeQueryDiagnostic, type QueryDiagnostic, type QueryStage } from "@/adapters/arca/query-diagnostics";
import { isValidCuit } from "@/domain/cuit";
import { inspectCertificate, assertKeyMatchesCertificate } from "@/lib/credentials/pem";
import { decryptPrivateKey, deriveAesKey } from "@/lib/db/credentials";
import { DrizzleCredentialsRepository, type CredentialsRepository } from "@/lib/db/credentials-repository";
import { clients } from "@/lib/db/schema";
import { DrizzleTaCacheStore } from "@/lib/db/ta-cache-store";
import type { Db } from "@/lib/db/types";

export interface PointOfSaleClient { id: string; cuit: string; ptoVta: number; razonSocial: string; condicionIva: string }
export interface PointsOfSaleReport {
  environment: "homologacion";
  client: PointOfSaleClient;
  fingerprint: string;
  checkedAt: string;
  points: PointOfSale[];
  configuredPoint: "available_cae" | "not_returned" | "not_available_cae" | "unverified";
}
export class PointsOfSaleError extends Error {
  readonly diagnostic?: QueryDiagnostic;
  constructor(readonly code: "environment" | "not_found" | "credentials" | "changed" | "timeout" | "upstream" | "cooldown", diagnostic?: QueryDiagnostic) {
    super(code); this.diagnostic = safeQueryDiagnostic(diagnostic);
  }
}
interface Attempt { at: number; validUntil: number; promise: Promise<PointsOfSaleReport> }
interface Options {
  repository: CredentialsRepository;
  getClient: (id: string) => Promise<PointOfSaleClient | null>;
  store: TaCacheStore;
  env: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
  attempts?: Map<string, Attempt>;
}
const MAX_BYTES = 1_048_576;
const COOLDOWN_MS = 15_000;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Independent deadline also bounds mocks/drivers which ignore AbortSignal. */
async function deadline<T>(ms: number, run: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal, stage?: () => QueryStage | undefined): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent?.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) controller.abort();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const current = stage?.();
      reject(new PointsOfSaleError("timeout", current ? { stage: current, category: "timeout" } : undefined));
      controller.abort();
    }, ms);
  });
  try { return await Promise.race([run(controller.signal), timeout]); }
  finally { clearTimeout(timer!); controller.abort(); parent?.removeEventListener("abort", abort); }
}

async function readBounded(response: Response, signal: AbortSignal, stage: QueryStage): Promise<string> {
  if (Number(response.headers.get("content-length")) > MAX_BYTES) throw new ArcaQueryError(stage, "response-too-large");
  if (!response.body) throw new ArcaQueryError(stage, "malformed-response");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new ArcaQueryError(stage, "response-too-large");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { signal.removeEventListener("abort", cancel); cancel(); }
}

function soapFault(xml: string, stage: QueryStage, httpStatus: number): ArcaQueryError | undefined {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) return;
  try {
    const parsed = new XMLParser({ removeNSPrefix: true, ignoreAttributes: true, parseTagValue: false }).parse(xml);
    const body = parsed?.Envelope?.Body;
    if (!body || typeof body !== "object" || !("Fault" in body)) return;
    const code = body.Fault?.faultcode;
    const providerCodes = typeof code === "string" && /^\d{1,9}$/.test(code) ? [Number(code)] : undefined;
    return new ArcaQueryError(stage, "soap-fault", { httpStatus, providerCodes });
  } catch { return; }
}

/** Fiscal read only; only the existing durable WSAA TA cache may be written. */
export function createPointsOfSaleChecker({ repository, getClient, store, env, fetchFn = fetch, attempts = new Map() }: Options) {
  return async (clientId: string, fingerprint: string): Promise<PointsOfSaleReport> => {
    if (env.ARCA_ENV !== "homologacion") throw new PointsOfSaleError("environment");
    let stage: QueryStage | undefined;
    try {
      return await deadline(10_000, async signal => {
        const client = await getClient(clientId);
        signal.throwIfAborted();
        if (!client) throw new PointsOfSaleError("not_found");
        if (!isValidCuit(client.cuit)) throw new PointsOfSaleError("upstream");
        const stored = await repository.get();
        signal.throwIfAborted();
        if (!stored) throw new PointsOfSaleError("credentials");
        let cert: ReturnType<typeof inspectCertificate>;
        let keyPem: string;
        try {
          cert = inspectCertificate(stored.certPem);
          if (cert.fingerprint !== fingerprint) throw new PointsOfSaleError("changed");
          if (Date.parse(cert.notBefore) > Date.now() || Date.parse(cert.notAfter) <= Date.now()) throw new PointsOfSaleError("credentials");
          keyPem = decryptPrivateKey(stored.encryptedKey, deriveAesKey(env.AES_KEY ?? ""));
          assertKeyMatchesCertificate(stored.certPem, keyPem);
        } catch (error) { throw error instanceof PointsOfSaleError ? error : new PointsOfSaleError("credentials"); }
        const snapshot = hash(client);
        const identity = hash(stored);
        const key = hash([WSFE_HOMOLOGACION_URL, identity, snapshot]);
        for (const [k, attempt] of attempts) {
          if (Date.now() - attempt.at >= COOLDOWN_MS || Date.now() >= attempt.validUntil) attempts.delete(k);
        }
        let attempt = attempts.get(key);
        if (!attempt) {
          if (attempts.size >= 128) throw new PointsOfSaleError("cooldown");
          attempt = { at: Date.now(), validUntil: Date.parse(cert.notAfter), promise: undefined! };
          const currentAttempt = attempt;
          const transport = { async post(url: string, body: string, headers: Record<string, string>) {
            const callStage = url === WSAA_HOMOLOGACION_URL ? "wsaa" : "wsfe";
            return deadline(4_000, async callSignal => {
              signal.throwIfAborted(); callSignal.throwIfAborted();
              if (url !== WSAA_HOMOLOGACION_URL && url !== WSFE_HOMOLOGACION_URL) throw new PointsOfSaleError("upstream");
              let response: Response | undefined;
              try {
                response = await fetchFn(url, { method: "POST", body, headers, redirect: "error", cache: "no-store", signal: callSignal });
                if (!response.ok && !response.body) throw new ArcaQueryError(callStage, "http", { httpStatus: response.status });
                const text = await readBounded(response, callSignal, callStage);
                const fault = soapFault(text, callStage, response.status);
                if (fault) throw fault;
                if (!response.ok) {
                  if (callStage === "wsfe") {
                    try { parseFeParamGetPtosVentaResponse(text); }
                    catch (error) {
                      if (error instanceof ArcaQueryError && error.diagnostic.category === "provider-errors") throw new ArcaQueryError(callStage, "provider-errors", { httpStatus: response.status, providerCodes: error.diagnostic.providerCodes });
                    }
                  }
                  throw new ArcaQueryError(callStage, "http", { httpStatus: response.status });
                }
                return text;
              } catch (error) {
                if (error instanceof PointsOfSaleError) throw error;
                if (error instanceof ArcaQueryError) throw new ArcaQueryError(callStage, error.diagnostic.category, { ...error.diagnostic, httpStatus: response?.status });
                throw new ArcaQueryError(callStage, callSignal.aborted ? "timeout" : "network", { httpStatus: response?.status });
              }
            }, signal, () => callStage);
          } };
          currentAttempt.promise = (async () => {
            try {
              const cache = createCredentialTaCache({ url: WSAA_HOMOLOGACION_URL, credentials: { certPem: stored.certPem, keyPem }, store, transport });
              stage = "wsaa";
              let ticket;
              try { ticket = await cache.get(ARCA_SERVICE_WSFE); }
              catch (error) {
                if (error instanceof ArcaQueryError || error instanceof PointsOfSaleError) throw error;
                throw new ArcaQueryError("wsaa", "internal");
              }
              signal.throwIfAborted();
              const expiresAt = Date.parse(ticket.expirationTime);
              currentAttempt.validUntil = Math.min(currentAttempt.validUntil, expiresAt);
              if (!ticket.token.trim() || !ticket.sign.trim() || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new ArcaQueryError("wsaa", "malformed-response");
              stage = "wsfe";
              const points = await new WsfeClient({ url: WSFE_HOMOLOGACION_URL, transport }).getPointsOfSale({ token: ticket.token, sign: ticket.sign, cuit: client.cuit });
              signal.throwIfAborted();
              if (Date.now() >= currentAttempt.validUntil) throw new PointsOfSaleError("upstream");
              const configured = points.find(point => point.number === client.ptoVta);
              const configuredPoint = !configured ? "not_returned" : configured.status === "unknown" ? "unverified" : configured.status === "available" && configured.emissionType === "CAE" ? "available_cae" : "not_available_cae";
              return { environment: "homologacion" as const, fingerprint, client, points, configuredPoint, checkedAt: new Date().toISOString() };
            } catch (error) {
              if (error instanceof PointsOfSaleError) throw error;
              if (error instanceof ArcaQueryError) throw new PointsOfSaleError(error.diagnostic.category === "timeout" ? "timeout" : "upstream", error.diagnostic);
              throw new PointsOfSaleError(signal.aborted ? "timeout" : "upstream", stage ? { stage, category: signal.aborted ? "timeout" : "internal" } : undefined);
            }
          })();
          attempts.set(key, attempt);
        }
        const result = await attempt.promise;
        const currentClient = await getClient(clientId);
        signal.throwIfAborted();
        const currentCredentials = await repository.get();
        signal.throwIfAborted();
        if (!currentClient || hash(currentClient) !== snapshot || !currentCredentials || hash(currentCredentials) !== identity) throw new PointsOfSaleError("changed");
        if (Date.now() >= attempt.validUntil) throw new PointsOfSaleError("upstream");
        return result;
      }, undefined, () => stage);
    } catch (error) { throw error instanceof PointsOfSaleError ? error : new PointsOfSaleError("upstream"); }
  };
}

const sharedAttempts = new Map<string, Attempt>();
export function checkClientPointsOfSale(db: Db, env: Record<string, string | undefined>, clientId: string, fingerprint: string) {
  return createPointsOfSaleChecker({
    repository: new DrizzleCredentialsRepository(db), store: new DrizzleTaCacheStore(db), env, attempts: sharedAttempts,
    getClient: async id => {
      const [client] = await db.select({ id: clients.id, cuit: clients.cuit, ptoVta: clients.ptoVta, razonSocial: clients.razonSocial, condicionIva: clients.condicionIva }).from(clients).where(eq(clients.id, id));
      return client ?? null;
    },
  })(clientId, fingerprint);
}
