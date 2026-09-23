import { describe, it, expect } from "vitest";
import {
  DEFAULT_TA_POLICY,
  parseWsaaExpiration,
  shouldRenew,
  TaCache,
  type TaCacheEntry,
  type TaCacheStore,
  type WsaaProvider,
} from "./ta-cache";

/** A mutable in-memory store (test double for the Drizzle store). */
function inMemoryStore(initial: Map<string, TaCacheEntry> = new Map()): {
  store: TaCacheStore;
  map: Map<string, TaCacheEntry>;
} {
  const map = initial;
  return {
    map,
    store: {
      async get(service) {
        return map.get(service) ?? null;
      },
      async put(service, entry) {
        map.set(service, entry);
      },
      async delete(service) {
        map.delete(service);
      },
    },
  };
}

/** A fake WSAA provider with a call log and optional per-call behavior. */
function fakeWsaa(ta: { token: string; sign: string; expirationTime: string }) {
  const calls: string[] = [];
  const provider: WsaaProvider = {
    async loginCms(service) {
      calls.push(service);
      return ta;
    },
  };
  return { provider, calls };
}

describe("ta-cache — shouldRenew (pure)", () => {
  const POLICY = { marginMs: 1000, cooldownMs: 1000 };

  it("reuses a comfortable (pre-margin) TA", () => {
    const entry = { token: "t", sign: "s", expiresAt: 20000, issuedAt: 5000 };
    expect(shouldRenew(10000, entry, POLICY)).toBe(false);
  });

  it("renews when within the safety margin AND the cooldown has elapsed", () => {
    const entry = { token: "t", sign: "s", expiresAt: 20000, issuedAt: 18000 };
    // now = 19200 → within margin (>= 19000) and now-issuedAt = 1200 >= 1000.
    expect(shouldRenew(19200, entry, POLICY)).toBe(true);
  });

  it("reuses when within the margin but the cooldown has NOT elapsed", () => {
    const entry = { token: "t", sign: "s", expiresAt: 20000, issuedAt: 19050 };
    // now = 19200 → within margin, but now-issuedAt = 150 < 1000 → reuse.
    expect(shouldRenew(19200, entry, POLICY)).toBe(false);
  });

  it("renews when expired regardless of cooldown", () => {
    const entry = { token: "t", sign: "s", expiresAt: 20000, issuedAt: 19999 };
    expect(shouldRenew(20000, entry, POLICY)).toBe(true);
    expect(shouldRenew(21000, entry, POLICY)).toBe(true);
  });
});

describe("ta-cache — parseWsaaExpiration", () => {
  it("parses an ARCA ISO expirationTime with -03:00 offset", () => {
    const ms = parseWsaaExpiration("2026-09-23T00:30:00-03:00");
    expect(ms).toBe(Date.parse("2026-09-23T03:30:00Z"));
  });

  it("throws on a malformed expirationTime", () => {
    expect(() => parseWsaaExpiration("not-a-date")).toThrow();
  });
});

describe("ta-cache — TaCache", () => {
  const EXPIRATION = "2026-09-23T00:30:00-03:00"; // valid, far future
  const EXPIRY_MS = parseWsaaExpiration(EXPIRATION);

  it("reuses a valid TA without calling WSAA", async () => {
    const { store, map } = inMemoryStore(
      new Map([
        [
          "wsfe",
          {
            token: "cached-token",
            sign: "cached-sign",
            expiresAt: EXPIRY_MS,
            issuedAt: EXPIRY_MS - 6 * 3600 * 1000,
          },
        ],
      ]),
    );
    const { provider, calls } = fakeWsaa({
      token: "new-token",
      sign: "new-sign",
      expirationTime: EXPIRATION,
    });
    const cache = new TaCache({
      wsaa: provider,
      store,
      clock: () => new Date(EXPIRY_MS - 3600 * 1000), // 1h before expiry
    });

    const ta = await cache.get("wsfe");
    expect(ta.token).toBe("cached-token");
    expect(calls).toHaveLength(0);
    expect(map.get("wsfe")?.token).toBe("cached-token");
  });

  it("renews when within the margin and stores the new TA", async () => {
    const { store } = inMemoryStore(
      new Map([
        [
          "wsfe",
          {
            token: "cached-token",
            sign: "cached-sign",
            expiresAt: EXPIRY_MS,
            issuedAt: EXPIRY_MS - 6 * 3600 * 1000,
          },
        ],
      ]),
    );
    const { provider, calls } = fakeWsaa({
      token: "new-token",
      sign: "new-sign",
      expirationTime: EXPIRATION,
    });
    const cache = new TaCache({
      wsaa: provider,
      store,
      // 1 minute before expiry → within the 5-minute margin, cooldown elapsed.
      clock: () => new Date(EXPIRY_MS - 60 * 1000),
    });

    const ta = await cache.get("wsfe");
    expect(ta.token).toBe("new-token");
    expect(calls).toEqual(["wsfe"]);
  });

  it("renews when expired", async () => {
    const { store } = inMemoryStore(
      new Map([
        [
          "wsfe",
          {
            token: "cached-token",
            sign: "cached-sign",
            expiresAt: EXPIRY_MS - 2 * 3600 * 1000,
            issuedAt: EXPIRY_MS - 8 * 3600 * 1000,
          },
        ],
      ]),
    );
    const { provider, calls } = fakeWsaa({
      token: "new-token",
      sign: "new-sign",
      expirationTime: EXPIRATION,
    });
    const cache = new TaCache({
      wsaa: provider,
      store,
      clock: () => new Date(EXPIRY_MS),
    });

    const ta = await cache.get("wsfe");
    expect(ta.token).toBe("new-token");
    expect(calls).toHaveLength(1);
  });

  it("caches the two services INDEPENDENTLY (separate keys, separate tokens)", async () => {
    const { store, map } = inMemoryStore();
    // A provider that returns a DISTINCT token per service, so value-level
    // independence is assertable (not just object-identity of two literals).
    const provider: WsaaProvider = {
      async loginCms(service) {
        return {
          token: `token-${service}`,
          sign: `sign-${service}`,
          expirationTime: EXPIRATION,
        };
      },
    };
    const cache = new TaCache({
      wsaa: provider,
      store,
      clock: () => new Date(EXPIRY_MS - 3600 * 1000),
    });

    const wsfeTa = await cache.get("wsfe");
    const padronTa = await cache.get("ws_sr_constancia_inscripcion");

    // Value-level independence: each service holds its OWN token.
    expect(wsfeTa.token).toBe("token-wsfe");
    expect(padronTa.token).toBe("token-ws_sr_constancia_inscripcion");
    expect(wsfeTa.token).not.toBe(padronTa.token);
    expect(map.has("wsfe")).toBe(true);
    expect(map.has("ws_sr_constancia_inscripcion")).toBe(true);
  });

  it("does not renew in a loop on WSAA cooldown — reuses the still-valid TA", async () => {
    const { store, map } = inMemoryStore(
      new Map([
        [
          "wsfe",
          {
            token: "cached-token",
            sign: "cached-sign",
            expiresAt: EXPIRY_MS,
            issuedAt: EXPIRY_MS - 6 * 3600 * 1000,
          },
        ],
      ]),
    );
    const calls: string[] = [];
    const provider: WsaaProvider = {
      async loginCms(service) {
        calls.push(service);
        // Simulate WSAA's "requested too frequently" rejection.
        throw new Error("WSAA cooldown: TA requested too recently");
      },
    };
    const cache = new TaCache({
      wsaa: provider,
      store,
      clock: () => new Date(EXPIRY_MS - 60 * 1000), // within margin
    });

    const ta = await cache.get("wsfe");
    expect(ta.token).toBe("cached-token");
    expect(calls).toEqual(["wsfe"]); // exactly one attempt, no retry loop
    expect(map.get("wsfe")?.token).toBe("cached-token");
  });

  it("does not call WSAA at all while within the margin AND within cooldown", async () => {
    const { store } = inMemoryStore(
      new Map([
        [
          "wsfe",
          {
            token: "cached-token",
            sign: "cached-sign",
            expiresAt: EXPIRY_MS,
            // issued 30s ago → within cooldown.
            issuedAt: EXPIRY_MS - 30 * 1000,
          },
        ],
      ]),
    );
    const calls: string[] = [];
    const provider: WsaaProvider = {
      async loginCms(service) {
        calls.push(service);
        throw new Error("should not be called");
      },
    };
    const cache = new TaCache({
      wsaa: provider,
      store,
      clock: () => new Date(EXPIRY_MS - 30 * 1000),
    });

    const ta = await cache.get("wsfe");
    expect(ta.token).toBe("cached-token");
    expect(calls).toHaveLength(0);
  });

  it("throws when renewal fails and no valid TA exists to fall back on", async () => {
    const { store } = inMemoryStore(
      new Map([
        [
          "wsfe",
          {
            token: "cached-token",
            sign: "cached-sign",
            expiresAt: EXPIRY_MS - 2 * 3600 * 1000, // already expired
            issuedAt: EXPIRY_MS - 8 * 3600 * 1000,
          },
        ],
      ]),
    );
    const provider: WsaaProvider = {
      async loginCms() {
        throw new Error("WSAA unavailable");
      },
    };
    const cache = new TaCache({
      wsaa: provider,
      store,
      clock: () => new Date(EXPIRY_MS),
    });

    await expect(cache.get("wsfe")).rejects.toThrow("WSAA unavailable");
  });

  it("uses DEFAULT_TA_POLICY margins (5 min) and cooldown (2 min)", () => {
    expect(DEFAULT_TA_POLICY.marginMs).toBe(5 * 60 * 1000);
    expect(DEFAULT_TA_POLICY.cooldownMs).toBe(2 * 60 * 1000);
  });

  it("scopes the cache key by certificate fingerprint (a rotated cert never reuses a TA)", async () => {
    const { store, map } = inMemoryStore();
    const { provider, calls } = fakeWsaa({
      token: "new-token",
      sign: "new-sign",
      expirationTime: EXPIRATION,
    });
    const cacheA = new TaCache({
      wsaa: provider,
      store,
      clock: () => new Date(EXPIRY_MS - 3600 * 1000),
      scope: "fp:aaaa",
    });
    const cacheB = new TaCache({
      wsaa: provider,
      store,
      clock: () => new Date(EXPIRY_MS - 3600 * 1000),
      scope: "fp:bbbb",
    });

    await cacheA.get("wsfe");
    // A DIFFERENT cert fingerprint must NOT reuse the first cert's TA.
    await cacheB.get("wsfe");

    expect(calls).toEqual(["wsfe", "wsfe"]); // two independent logins
    expect(map.has("fp:aaaa:wsfe")).toBe(true);
    expect(map.has("fp:bbbb:wsfe")).toBe(true);
  });

  it("single-flight: concurrent cold-cache requests share ONE loginCms", async () => {
    const { store } = inMemoryStore();
    let calls = 0;
    let resolveLogin!: (ta: { token: string; sign: string; expirationTime: string }) => void;
    const provider: WsaaProvider = {
      loginCms() {
        calls++;
        return new Promise((resolve) => {
          resolveLogin = resolve;
        });
      },
    };
    const cache = new TaCache({
      wsaa: provider,
      store,
      clock: () => new Date(EXPIRY_MS - 3600 * 1000),
    });

    const p1 = cache.get("wsfe");
    const p2 = cache.get("wsfe");
    // Flush microtasks so both requests reach the single-flight gate.
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(1);

    resolveLogin({ token: "shared", sign: "s", expirationTime: EXPIRATION });
    const [ta1, ta2] = await Promise.all([p1, p2]);
    expect(ta1.token).toBe("shared");
    expect(ta2.token).toBe("shared");
    expect(calls).toBe(1);
  });

  it("returns a valid TA even when store.put fails (cache-write failure is not fatal)", async () => {
    const { provider, calls } = fakeWsaa({
      token: "new-token",
      sign: "new-sign",
      expirationTime: EXPIRATION,
    });
    const store: TaCacheStore = {
      async get() {
        return null;
      },
      async put() {
        throw new Error("db write failed");
      },
    };
    const cache = new TaCache({
      wsaa: provider,
      store,
      clock: () => new Date(EXPIRY_MS - 3600 * 1000),
    });

    const ta = await cache.get("wsfe");
    expect(ta.token).toBe("new-token"); // the valid TA is NOT discarded
    expect(calls).toEqual(["wsfe"]);
  });

  it("evicts a cached TA (used on auth rejection before a fresh retry)", async () => {
    const { store, map } = inMemoryStore(
      new Map([
        [
          "wsfe",
          {
            token: "cached-token",
            sign: "cached-sign",
            expiresAt: EXPIRY_MS,
            issuedAt: EXPIRY_MS - 3600 * 1000,
          },
        ],
      ]),
    );
    const { provider } = fakeWsaa({
      token: "new-token",
      sign: "new-sign",
      expirationTime: EXPIRATION,
    });
    const cache = new TaCache({
      wsaa: provider,
      store,
      clock: () => new Date(EXPIRY_MS - 3600 * 1000),
    });

    expect(map.has("wsfe")).toBe(true);
    await cache.evict("wsfe");
    expect(map.has("wsfe")).toBe(false);
  });
});
