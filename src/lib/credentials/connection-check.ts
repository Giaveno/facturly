import { HOMOLOGACION_CALL_MS, HOMOLOGACION_QUERY_MS } from "@/adapters/arca/timeouts";
import { ARCA_SERVICE_PADRON, ARCA_SERVICE_WSFE, WSAA_HOMOLOGACION_URL } from "@/adapters/arca/constants";
import { createCredentialTaCache } from "@/adapters/arca/credential-ta-cache";
import { createFetchTransport } from "@/adapters/arca/http";
import type { TaCacheStore } from "@/adapters/arca/ta-cache";
import { decryptPrivateKey, deriveAesKey } from "@/lib/db/credentials";
import { DrizzleCredentialsRepository, type CredentialsRepository } from "@/lib/db/credentials-repository";
import { DrizzleTaCacheStore } from "@/lib/db/ta-cache-store";
import type { Db } from "@/lib/db/types";
import { inspectCertificate, type CertificateInfo } from "./pem";

export type ConnectionStatus = "ok" | "failure" | "timeout" | "not_configured";
type Service = typeof ARCA_SERVICE_WSFE | typeof ARCA_SERVICE_PADRON;
export interface ConnectionReport {
  environment: "homologacion";
  certificate: CertificateInfo | null;
  services: { service: Service; status: ConnectionStatus }[];
}
export class ConnectionCheckError extends Error {
  constructor(readonly code: "environment" | "changed" | "timeout") { super(code); }
}
const SERVICES = [ARCA_SERVICE_WSFE, ARCA_SERVICE_PADRON] as const;
const CALL_MS = HOMOLOGACION_CALL_MS;
const TOTAL_MS = HOMOLOGACION_QUERY_MS;
const COOLDOWN_MS = 15_000;
interface Attempt { fingerprint: string; at: number; validUntil: () => number; promise: Promise<ConnectionReport> }
interface CheckState { attempt?: Attempt }
interface Options {
  repository: CredentialsRepository;
  store: TaCacheStore;
  env: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
  state?: CheckState;
}

/** Authenticates only. No gateway, WSFE operations, issuer/PV writes, or emission switch. */
export function createConnectionChecker({ repository, store, env, fetchFn, state = {} }: Options) {
  return async (fingerprint: string): Promise<ConnectionReport> => {
    if (env.ARCA_ENV !== "homologacion") throw new ConnectionCheckError("environment");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new ConnectionCheckError("timeout")); }, TOTAL_MS);
    });
    const report = (certificate: CertificateInfo | null, status: ConnectionStatus): ConnectionReport => ({
      environment: "homologacion", certificate, services: SERVICES.map(service => ({ service, status })),
    });
    async function execute(): Promise<ConnectionReport> {
      const stored = await repository.get();
      controller.signal.throwIfAborted();
      if (!stored) return report(null, "not_configured");
      let certificate: CertificateInfo;
      try { certificate = inspectCertificate(stored.certPem); } catch { return report(null, "not_configured"); }
      if (certificate.fingerprint !== fingerprint) throw new ConnectionCheckError("changed");
      let keyPem: string;
      try { keyPem = decryptPrivateKey(stored.encryptedKey, deriveAesKey(env.AES_KEY ?? "")); }
      catch { return report(certificate, "not_configured"); }

      // One identity at a time per process: share in-flight attempts and briefly cool down failures.
      // Durable TA entries (not this guard) prevent repeated logins after cold starts.
      if (state.attempt?.fingerprint !== fingerprint || Date.now() - state.attempt.at >= COOLDOWN_MS || Date.now() >= state.attempt.validUntil()) {
        const transport = createFetchTransport({
          fetchFn: (url, init) => (fetchFn ?? fetch)(url, { ...init, redirect: "error", cache: "no-store" }),
          abortSignalTimeout: () => AbortSignal.any([controller.signal, AbortSignal.timeout(CALL_MS)]),
        });
        const cache = createCredentialTaCache({
          url: WSAA_HOMOLOGACION_URL, credentials: { certPem: stored.certPem, keyPem }, store,
          transport: { async post(url, body, headers) {
            controller.signal.throwIfAborted();
            try { return await transport.post(url, body, headers); }
            catch (error) {
              const cause = error instanceof Error ? error.cause : undefined;
              if (cause instanceof DOMException && ["AbortError", "TimeoutError"].includes(cause.name)) throw new ConnectionCheckError("timeout");
              throw error;
            }
          } },
        });
        let validUntil = Infinity;
        const promise: Promise<ConnectionReport> = Promise.all(SERVICES.map(async service => {
          try {
            const ticket = await cache.get(service);
            const expiresAt = Date.parse(ticket.expirationTime);
            // A cache renewal fallback can expire while the remote call is in flight.
            if (!ticket.token.trim() || !ticket.sign.trim() || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error("Unusable ticket");
            validUntil = Math.min(validUntil, expiresAt);
            return { service, status: "ok" as const };
          } catch (error) {
            return { service, status: error instanceof ConnectionCheckError && error.code === "timeout" ? "timeout" as const : "failure" as const };
          }
        })).then(services => ({ environment: "homologacion" as const, certificate, services }));
        state.attempt = { fingerprint, at: Date.now(), validUntil: () => validUntil, promise };
      }
      const attempt = state.attempt;
      const result = await attempt.promise;
      const current = await repository.get();
      controller.signal.throwIfAborted();
      if (!current || inspectCertificate(current.certPem).fingerprint !== fingerprint) throw new ConnectionCheckError("changed");
      if (Date.now() >= attempt.validUntil()) return { ...result, services: result.services.map(item => item.status === "ok" ? { ...item, status: "failure" } : item) };
      return result;
    }
    try { return await Promise.race([execute(), timeout]); }
    finally { clearTimeout(timer!); }
  };
}

const sharedState: CheckState = {};
export function checkCredentialConnection(db: Db, env: Record<string, string | undefined>, fingerprint: string) {
  return createConnectionChecker({ repository: new DrizzleCredentialsRepository(db), store: new DrizzleTaCacheStore(db), env, state: sharedState })(fingerprint);
}
