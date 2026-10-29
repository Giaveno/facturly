import { createHash } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { ARCA_SERVICE_PADRON, PADRON_HOMOLOGACION_URL, WSAA_HOMOLOGACION_URL } from "@/adapters/arca/constants";
import { createCredentialTaCache } from "@/adapters/arca/credential-ta-cache";
import { buildPadronLookupEnvelope, padronFaultReason, parsePadronLookup } from "@/adapters/arca/padron-lookup";
import { ArcaQueryError, safeQueryDiagnostic, type QueryDiagnostic, type QueryStage } from "@/adapters/arca/query-diagnostics";
import type { TaCacheStore } from "@/adapters/arca/ta-cache";
import { inspectCertificate, assertKeyMatchesCertificate } from "@/lib/credentials/pem";
import { decryptPrivateKey, deriveAesKey } from "@/lib/db/credentials";
import { DrizzleCredentialsRepository, type CredentialsRepository } from "@/lib/db/credentials-repository";
import { DrizzleTaCacheStore } from "@/lib/db/ta-cache-store";
import type { Db } from "@/lib/db/types";
import { normalizeLookupCuit, type PadronLookupReport } from "./contract";
export { normalizeLookupCuit, type PadronLookupReport } from "./contract";

export class PadronLookupError extends Error {
  readonly diagnostic?: QueryDiagnostic;
  constructor(readonly code: "environment" | "invalid_cuit" | "credentials" | "changed" | "timeout" | "upstream" | "cooldown", diagnostic?: QueryDiagnostic) {
    super(code); this.diagnostic = safeQueryDiagnostic(diagnostic);
  }
}
interface Attempt { at: number; validUntil: number; target: string; promise: Promise<PadronLookupReport> }
interface Options {
  repository: CredentialsRepository;
  store: TaCacheStore;
  env: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
  attempts?: Map<string, Attempt>;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const MAX_BYTES = 1_048_576;
const COOLDOWN_MS = 15_000;
async function deadline<T>(ms: number, run: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal, stage?: () => QueryStage | undefined): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent?.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) controller.abort();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { const current = stage?.(); reject(new PadronLookupError("timeout", current ? { stage: current, category: "timeout" } : undefined)); controller.abort(); }, ms);
  });
  try { return await Promise.race([run(controller.signal), timeout]); }
  finally { clearTimeout(timer!); controller.abort(); parent?.removeEventListener("abort", abort); }
}
async function readBounded(response: Response, signal: AbortSignal, stage: QueryStage) {
  if (Number(response.headers.get("content-length")) > MAX_BYTES) throw new ArcaQueryError(stage, "response-too-large");
  if (!response.body) throw new ArcaQueryError(stage, "malformed-response");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted(); const { done, value } = await reader.read(); signal.throwIfAborted();
      if (done) break;
      size += value.byteLength; if (size > MAX_BYTES) throw new ArcaQueryError(stage, "response-too-large"); chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { signal.removeEventListener("abort", cancel); cancel(); }
}

/** Read-only fiscal lookup. The only permitted write is the existing scoped WSAA TA cache. */
export function createPadronLookup({ repository, store, env, fetchFn = fetch, attempts = new Map() }: Options) {
  return async (inputCuit: string, fingerprint: string): Promise<PadronLookupReport> => {
    if (env.ARCA_ENV !== "homologacion") throw new PadronLookupError("environment");
    const target = normalizeLookupCuit(inputCuit);
    if (!target) throw new PadronLookupError("invalid_cuit");
    let stage: QueryStage | undefined;
    try {
      return await deadline(10_000, async signal => {
        const stored = await repository.get(); signal.throwIfAborted();
        if (!stored) throw new PadronLookupError("credentials");
        let cert: ReturnType<typeof inspectCertificate>; let keyPem: string;
        try {
          cert = inspectCertificate(stored.certPem);
          if (cert.fingerprint !== fingerprint) throw new PadronLookupError("changed");
          if (!cert.cuit || Date.parse(cert.notBefore) > Date.now() || Date.parse(cert.notAfter) <= Date.now()) throw new PadronLookupError("credentials");
          keyPem = decryptPrivateKey(stored.encryptedKey, deriveAesKey(env.AES_KEY ?? ""));
          assertKeyMatchesCertificate(stored.certPem, keyPem);
        } catch (error) { throw error instanceof PadronLookupError ? error : new PadronLookupError("credentials"); }
        const identity = hash(stored);
        const key = hash([PADRON_HOMOLOGACION_URL, identity]);
        for (const [k, attempt] of attempts) if (Date.now() - attempt.at >= COOLDOWN_MS || Date.now() >= attempt.validUntil) attempts.delete(k);
        let attempt = attempts.get(key);
        if (attempt && attempt.target !== target) throw new PadronLookupError("cooldown");
        if (!attempt) {
          if (attempts.size >= 128) throw new PadronLookupError("cooldown");
          attempt = { at: Date.now(), validUntil: Date.parse(cert.notAfter), target, promise: undefined! };
          const currentAttempt = attempt;
          const transport = { async post(url: string, body: string, headers: Record<string, string>) {
            const callStage = url === WSAA_HOMOLOGACION_URL ? "wsaa" : "padron";
            return deadline(4_000, async callSignal => {
              signal.throwIfAborted(); callSignal.throwIfAborted();
              if (url !== WSAA_HOMOLOGACION_URL && url !== PADRON_HOMOLOGACION_URL) throw new PadronLookupError("upstream");
              let response: Response | undefined;
              try {
                response = await fetchFn(url, { method: "POST", body, headers, redirect: "error", cache: "no-store", signal: callSignal });
                const text = await readBounded(response, callSignal, callStage);
                if (!/<!DOCTYPE|<!ENTITY/i.test(text) && XMLValidator.validate(text) === true) {
                  const parsed = new XMLParser({ removeNSPrefix: true, ignoreAttributes: true, parseTagValue: false }).parse(text);
                  if (parsed?.Envelope?.Body && "Fault" in parsed.Envelope.Body) throw new ArcaQueryError(callStage, "soap-fault", callStage === "padron" ? { faultReason: padronFaultReason(parsed.Envelope.Body.Fault) } : {});
                }
                if (!response.ok) throw new ArcaQueryError(callStage, "http", { httpStatus: response.status });
                return text;
              } catch (error) {
                if (error instanceof PadronLookupError) throw error;
                if (error instanceof ArcaQueryError) throw new ArcaQueryError(callStage, error.diagnostic.category, { ...error.diagnostic, httpStatus: response?.status });
                throw new ArcaQueryError(callStage, callSignal.aborted ? "timeout" : "network", { httpStatus: response?.status });
              }
            }, signal, () => callStage);
          } };
          currentAttempt.promise = (async () => {
            try {
              stage = "wsaa";
              const cache = createCredentialTaCache({ url: WSAA_HOMOLOGACION_URL, credentials: { certPem: stored.certPem, keyPem }, store, transport });
              let ticket;
              try { ticket = await cache.get(ARCA_SERVICE_PADRON); }
              catch (error) { if (error instanceof ArcaQueryError || error instanceof PadronLookupError) throw error; throw new ArcaQueryError("wsaa", "internal"); }
              signal.throwIfAborted();
              const expiresAt = Date.parse(ticket.expirationTime);
              currentAttempt.validUntil = Math.min(currentAttempt.validUntil, expiresAt);
              if (!ticket.token.trim() || !ticket.sign.trim() || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new ArcaQueryError("wsaa", "malformed-response");
              stage = "padron";
              const xml = await transport.post(PADRON_HOMOLOGACION_URL, buildPadronLookupEnvelope({ token: ticket.token, sign: ticket.sign, cuitRepresentada: cert.cuit! }, target), { "Content-Type": "text/xml; charset=utf-8", SOAPAction: "" });
              signal.throwIfAborted();
              const data = parsePadronLookup(xml, target);
              if (Date.now() >= currentAttempt.validUntil) throw new PadronLookupError("upstream");
              return { ...data, cuit: target, environment: "homologacion" as const, fingerprint, checkedAt: new Date().toISOString(), authentication: "authenticated" as const, dataResponse: "received" as const };
            } catch (error) {
              if (error instanceof PadronLookupError) throw error;
              if (error instanceof ArcaQueryError) throw new PadronLookupError(error.diagnostic.category === "timeout" ? "timeout" : "upstream", error.diagnostic);
              throw new PadronLookupError("upstream", stage ? { stage, category: "internal" } : undefined);
            }
          })();
          attempts.set(key, attempt);
        }
        const result = await attempt.promise;
        const current = await repository.get(); signal.throwIfAborted();
        if (!current || hash(current) !== identity) throw new PadronLookupError("changed");
        if (Date.now() >= attempt.validUntil) throw new PadronLookupError("upstream");
        return result;
      }, undefined, () => stage);
    } catch (error) { throw error instanceof PadronLookupError ? error : new PadronLookupError("upstream"); }
  };
}
const sharedAttempts = new Map<string, Attempt>();
export function lookupCuit(db: Db, env: Record<string, string | undefined>, cuit: string, fingerprint: string) {
  return createPadronLookup({ repository: new DrizzleCredentialsRepository(db), store: new DrizzleTaCacheStore(db), env, attempts: sharedAttempts })(cuit, fingerprint);
}
