import { WSAA_HOMOLOGACION_URL } from "./constants";
import { arcaTimeouts } from "./timeouts";
import { X509Certificate } from "node:crypto";
import { TaCache, type TaCacheOptions } from "./ta-cache";
import { WsaaClient, type WsaaClientOptions, type WsaaTa } from "./wsaa";
import { ArcaQueryError } from "./query-diagnostics";

// Independent per-request cache instances still represent the same WSAA identity.
// Share only active refreshes/reads, never retain a resolved ticket in process memory.
const pendingTickets = new Map<string, Promise<WsaaTa>>();


/** Public SHA-256 identity, independent of PEM whitespace/line endings. */
export function certificateFingerprint(certPem: string): string {
  return new X509Certificate(certPem).fingerprint256.replaceAll(":", "").toLowerCase();
}

type Options = Omit<WsaaClientOptions, "credentials"> & {
  credentials: WsaaClientOptions["credentials"];
  store: TaCacheOptions["store"];
  scope?: string;
};

/** Resolve provider credentials BEFORE choosing a cache. Never use legacy unscoped tickets. */
export function createCredentialTaCache(options: Options): Pick<TaCache, "get" | "evict"> {
  async function resolve() {
    const credentials = typeof options.credentials === "function" ? await options.credentials() : options.credentials;
    const scope = `${options.url}:${certificateFingerprint(credentials.certPem)}${options.scope ? `:${options.scope}` : ""}`;
    return { credentials, scope };
  }
  function cacheFor(credentials: Awaited<ReturnType<typeof resolve>>["credentials"], scope: string, assertActive = () => {}) {
    return new TaCache({
      wsaa: new WsaaClient({ ...options, credentials, transport: {
        async post(...args) {
          assertActive(); const response = await options.transport.post(...args); assertActive(); return response;
        },
      } }),
      store: {
        async get(key) { assertActive(); const entry = await options.store.get(key); assertActive(); return entry; },
        async put(key, entry) { assertActive(); await options.store.put(key, entry); assertActive(); },
        delete: options.store.delete?.bind(options.store),
      },
      scope, clock: options.clock, logger: options.logger, metrics: options.metrics,
    });
  }
  return {
    get: async service => {
      const { scope, credentials } = await resolve();
      const key = JSON.stringify([scope, service]);
      const pending = pendingTickets.get(key);
      if (pending) return pending;
      if (pendingTickets.size >= 128) throw new ArcaQueryError("wsaa", "cooldown");
      let active = true;
      const assertActive = () => { if (!active) throw new ArcaQueryError("wsaa", "timeout"); };
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { active = false; reject(new ArcaQueryError("wsaa", "timeout")); }, arcaTimeouts(options.url === WSAA_HOMOLOGACION_URL ? "homologacion" : "production").acquisitionMs);
      });
      // A new cache per bounded acquisition also avoids its instance-local stuck inflight map.
      const request = Promise.race([cacheFor(credentials, scope, assertActive).get(service), timeout]);
      pendingTickets.set(key, request);
      try { return await request; }
      finally {
        active = false; clearTimeout(timer!);
        if (pendingTickets.get(key) === request) pendingTickets.delete(key);
      }
    },
    evict: async service => { const { credentials, scope } = await resolve(); await cacheFor(credentials, scope).evict(service); },
  };
}
