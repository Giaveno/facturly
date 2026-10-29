import { afterEach, expect, it, vi } from "vitest";
import { generateSelfSignedCert } from "@/test-support/pkcs7";
import { signTraCms } from "./wsaa";
import { createCredentialTaCache } from "./credential-ta-cache";
import type { TaCacheEntry } from "./ta-cache";
afterEach(() => vi.useRealTimers());

it("pins provider credentials to certificate+endpoint cache identity across rotation and environments", async () => {
  const first = generateSelfSignedCert("FIRST"); const second = generateSelfSignedCert("SECOND"); let pair = first;
  const entries = new Map<string, TaCacheEntry>();
  const store = { get: async (key: string) => entries.get(key) ?? null, put: async (key: string, value: TaCacheEntry) => { entries.set(key, value); } };
  const post = vi.fn(async () => {
    const inner = `<loginTicketResponse><header><expirationTime>${new Date(Date.now() + 3600000).toISOString()}</expirationTime></header><credentials><token>token</token><sign>sign</sign></credentials></loginTicketResponse>`;
    return `<Envelope><Body><loginCmsResponse><loginCmsReturn>${signTraCms(pair, inner)}</loginCmsReturn></loginCmsResponse></Body></Envelope>`;
  });
  const config = { credentials: async () => pair, store, transport: { post }, url: "https://homologacion.example" };
  const cache = createCredentialTaCache(config);
  await cache.get("wsfe"); await cache.get("wsfe"); expect(post).toHaveBeenCalledTimes(1);
  await createCredentialTaCache(config).get("wsfe"); expect(post).toHaveBeenCalledTimes(1);
  pair = second; await cache.get("wsfe"); expect(post).toHaveBeenCalledTimes(2);
  await createCredentialTaCache({ ...config, url: "https://production.example" }).get("wsfe"); expect(post).toHaveBeenCalledTimes(3);
  expect(entries.size).toBe(3);
});

it("shares only active certificate/endpoint/service identities across cache instances", async () => {
  const first = generateSelfSignedCert("SHARED"); const second = generateSelfSignedCert("ISOLATED");
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const post = vi.fn(async () => {
    await gate;
    return `<Envelope><Body><loginCmsResponse><loginCmsReturn><![CDATA[<loginTicketResponse><header><expirationTime>${new Date(Date.now() + 3600000).toISOString()}</expirationTime></header><credentials><token>token</token><sign>sign</sign></credentials></loginTicketResponse>]]></loginCmsReturn></loginCmsResponse></Body></Envelope>`;
  });
  const config = { credentials: first, url: "https://homologacion.example", transport: { post }, store: { get: async () => null, put: async () => {} } };
  const pending = Promise.all([
    createCredentialTaCache(config).get("wsfe"), createCredentialTaCache(config).get("wsfe"),
    createCredentialTaCache(config).get("padron"),
    createCredentialTaCache({ ...config, credentials: second }).get("wsfe"),
    createCredentialTaCache({ ...config, url: "https://production.example" }).get("wsfe"),
  ]);
  try { await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(4)); }
  finally { release(); }
  await pending;
  // No in-memory ticket survives completion: an empty durable store renews again.
  await createCredentialTaCache(config).get("wsfe"); expect(post).toHaveBeenCalledTimes(5);
});

it("removes rejected shared refreshes so a later attempt can retry", async () => {
  const credentials = generateSelfSignedCert("RETRY");
  const post = vi.fn(async (): Promise<string> => { throw new Error("authentication failed"); });
  const config = { credentials, url: "https://homologacion.example", transport: { post }, store: { get: async () => null, put: async () => {} } };
  const first = createCredentialTaCache(config); const second = createCredentialTaCache(config);
  const results = await Promise.allSettled([first.get("wsfe"), second.get("wsfe")]);
  expect(results.every(result => result.status === "rejected")).toBe(true); expect(post).toHaveBeenCalledTimes(1);
  await expect(second.get("wsfe")).rejects.toThrow(); expect(post).toHaveBeenCalledTimes(2);
});

it("expires hung persistence without poisoning retries or releasing their newer identity", async () => {
  const credentials = generateSelfSignedCert("HUNG"); vi.useFakeTimers();
  let releaseOld!: (value: TaCacheEntry | null) => void;
  let releaseNew!: (value: TaCacheEntry | null) => void;
  const get = vi.fn<(key: string) => Promise<TaCacheEntry | null>>()
    .mockImplementationOnce(() => new Promise(resolve => { releaseOld = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { releaseNew = resolve; }));
  const post = vi.fn();
  const cache = createCredentialTaCache({ credentials, url: "https://homologacion.example", transport: { post }, store: { get, put: async () => {} } });
  const expired = expect(cache.get("wsfe")).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(8100); await expired;
  const retry = cache.get("wsfe"); await vi.advanceTimersByTimeAsync(0);
  // The old persistence call resumes after its deadline and must not start LoginCms.
  releaseOld(null); await vi.advanceTimersByTimeAsync(0);
  const joined = cache.get("wsfe"); await vi.advanceTimersByTimeAsync(0);
  expect(get).toHaveBeenCalledTimes(2); expect(post).not.toHaveBeenCalled();
  releaseNew({ token: "recovered", sign: "sign", issuedAt: Date.now(), expiresAt: Date.now() + 3600000 });
  expect((await retry).token).toBe("recovered"); expect(await joined).toEqual(await retry);
});

it("also releases an identity when a cache write never settles", async () => {
  const credentials = generateSelfSignedCert("HUNG-WRITE"); vi.useFakeTimers();
  const post = vi.fn(async () => `<Envelope><Body><loginCmsResponse><loginCmsReturn><![CDATA[<loginTicketResponse><header><expirationTime>${new Date(Date.now() + 3600000).toISOString()}</expirationTime></header><credentials><token>token</token><sign>sign</sign></credentials></loginTicketResponse>]]></loginCmsReturn></loginCmsResponse></Body></Envelope>`);
  const put = vi.fn<(key: string, entry: TaCacheEntry) => Promise<void>>()
    .mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue(undefined);
  const config = { credentials, url: "https://homologacion.example", transport: { post }, store: { get: async () => null, put } };
  const cache = createCredentialTaCache(config);
  const expired = expect(cache.get("wsfe")).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(8100); await expired;
  expect((await cache.get("wsfe")).token).toBe("token"); expect(post).toHaveBeenCalledTimes(2);
});
