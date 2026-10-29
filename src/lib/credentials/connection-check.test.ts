import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { generateSelfSignedCert } from "@/test-support/pkcs7";
import { deriveAesKey, encryptPrivateKey } from "@/lib/db/credentials";
import { inspectCertificate } from "./pem";
import { signTraCms } from "@/adapters/arca/wsaa";
import { WSAA_HOMOLOGACION_URL } from "@/adapters/arca/constants";
import type { StoredCredentials } from "@/lib/db/credentials-repository";
import type { TaCacheEntry } from "@/adapters/arca/ta-cache";
import { ConnectionCheckError, createConnectionChecker } from "./connection-check";

const AES = "01".repeat(32);
let pair: ReturnType<typeof generateSelfSignedCert>;
let other: ReturnType<typeof generateSelfSignedCert>;
beforeAll(() => { pair = generateSelfSignedCert("TEST CUIT 30710145764"); other = generateSelfSignedCert("OTHER"); });
afterEach(() => vi.useRealTimers());

function setup(env: Record<string, string | undefined> = { ARCA_ENV: "homologacion", AES_KEY: AES }) {
  let stored: StoredCredentials | null = { certPem: pair.certPem, encryptedKey: encryptPrivateKey(pair.keyPem, deriveAesKey(AES)) };
  const repository = { get: vi.fn(async () => stored) };
  const entries = new Map<string, TaCacheEntry>();
  const store = { get: vi.fn(async (key: string) => entries.get(key) ?? null), put: vi.fn(async (key: string, value: TaCacheEntry) => { entries.set(key, value); }) };
  const fetchFn = vi.fn<typeof fetch>(async () => {
    const ticket = `<loginTicketResponse><header><expirationTime>${new Date(Date.now() + 3600000).toISOString()}</expirationTime></header><credentials><token>SECRET_TOKEN</token><sign>SECRET_SIGN</sign></credentials></loginTicketResponse>`;
    return new Response(`<Envelope><Body><loginCmsResponse><loginCmsReturn>${signTraCms(pair, ticket)}</loginCmsReturn></loginCmsResponse></Body></Envelope>`);
  });
  const check = createConnectionChecker({ repository, store, env, fetchFn });
  return { check, repository, store, fetchFn, entries, replace: (value: StoredCredentials | null) => { stored = value; }, fingerprint: () => inspectCertificate(pair.certPem).fingerprint };
}

describe("persisted credential homologation authentication check", () => {
  it.each(["production", "invalid", "", undefined])("refuses environment %s before loading/decrypting or networking", async value => {
    const s = setup({ ARCA_ENV: value, AES_KEY: AES });
    await expect(s.check(s.fingerprint())).rejects.toMatchObject({ code: "environment" });
    expect(s.repository.get).not.toHaveBeenCalled(); expect(s.fetchFn).not.toHaveBeenCalled();
  });
  it("authenticates both fixed services, returns only public metadata and reuses durable tickets", async () => {
    expect(WSAA_HOMOLOGACION_URL).toBe("https://wsaahomo.afip.gov.ar/ws/services/LoginCms");
    const s = setup();
    const result = await s.check(s.fingerprint());
    expect(result.environment).toBe("homologacion");
    expect(result.certificate?.fingerprint).toBe(s.fingerprint());
    expect(result.services).toEqual([{ service: "wsfe", status: "ok" }, { service: "ws_sr_constancia_inscripcion", status: "ok" }]);
    expect(s.fetchFn).toHaveBeenCalledTimes(2);
    for (const [url, init] of s.fetchFn.mock.calls) {
      expect(url).toBe(WSAA_HOMOLOGACION_URL); expect(init?.redirect).toBe("error");
      expect(init?.body).toContain("loginCms"); expect(init?.body).not.toContain("FECAESolicitar");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect([...s.entries.keys()].every(key => key.includes(s.fingerprint()) && key.includes(WSAA_HOMOLOGACION_URL))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SECRET_TOKEN|SECRET_SIGN|BEGIN|stack|certPem|keyPem/);
    await s.check(s.fingerprint()); expect(s.fetchFn).toHaveBeenCalledTimes(2);
    // A new checker/process can reuse persisted tickets without issuing LoginCms again.
    const next = createConnectionChecker({ repository: s.repository, store: s.store, env: { ARCA_ENV: "homologacion", AES_KEY: AES }, fetchFn: s.fetchFn });
    await next(s.fingerprint()); expect(s.fetchFn).toHaveBeenCalledTimes(2);
  });
  it("reports missing credentials and bad encryption without contacting ARCA", async () => {
    const s = setup(); s.replace(null);
    expect((await s.check(s.fingerprint())).services.every(r => r.status === "not_configured")).toBe(true);
    s.replace({ certPem: pair.certPem, encryptedKey: encryptPrivateKey(pair.keyPem, deriveAesKey("02".repeat(32))) });
    expect((await s.check(s.fingerprint())).services.every(r => r.status === "not_configured")).toBe(true);
    expect(s.fetchFn).not.toHaveBeenCalled();
  });
  it.each(["", "2000-01-01T00:00:00Z"])("does not report OK for an unusable ticket with expiry %s", async expirationTime => {
    const s = setup();
    const ticket = `<loginTicketResponse><header><expirationTime>${expirationTime}</expirationTime></header><credentials><token></token><sign></sign></credentials></loginTicketResponse>`;
    s.fetchFn.mockImplementation(async () => new Response(`<Envelope><Body><loginCmsResponse><loginCmsReturn><![CDATA[${ticket}]]></loginCmsReturn></loginCmsResponse></Body></Envelope>`));
    expect((await s.check(s.fingerprint())).services.every(result => result.status === "failure")).toBe(true);
  });
  it("does not reuse another environment's or certificate's cached tokens", async () => {
    const s = setup();
    s.entries.set("wsfe", { token: "OLD", sign: "OLD", expiresAt: Date.now() + 3600000, issuedAt: Date.now() });
    s.entries.set(`production:${s.fingerprint()}:wsfe`, { token: "OLD", sign: "OLD", expiresAt: Date.now() + 3600000, issuedAt: Date.now() });
    await s.check(s.fingerprint()); expect(s.fetchFn).toHaveBeenCalledTimes(2);
    s.replace({ certPem: other.certPem, encryptedKey: encryptPrivateKey(other.keyPem, deriveAesKey(AES)) });
    await expect(s.check(s.fingerprint())).rejects.toMatchObject({ code: "changed" });
    await s.check(inspectCertificate(other.certPem).fingerprint); expect(s.fetchFn).toHaveBeenCalledTimes(4);
  });
  it("coalesces concurrent checks and cools down failures without trusting raw remote errors", async () => {
    const s = setup(); const log = vi.spyOn(console, "error").mockImplementation(() => {});
    s.fetchFn.mockResolvedValueOnce(new Response("<Envelope><Body><Fault><faultcode>auth</faultcode><faultstring>SECRET_TOKEN SECRET_SIGN PRIVATE KEY</faultstring></Fault></Body></Envelope>", { status: 500 }));
    try {
      const [a, b] = await Promise.all([s.check(s.fingerprint()), s.check(s.fingerprint())]);
      expect(a).toEqual(b); expect(a.services.map(r => r.status)).toEqual(["failure", "ok"]);
      await s.check(s.fingerprint()); expect(s.fetchFn).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(a)).not.toMatch(/SECRET|PRIVATE|stack/); expect(log).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
  it("rejects results if the stored certificate changes while the check runs", async () => {
    const s = setup(); const original = s.fetchFn.getMockImplementation()!;
    s.fetchFn.mockImplementation(async (...args) => { s.replace({ certPem: other.certPem, encryptedKey: encryptPrivateKey(other.keyPem, deriveAesKey(AES)) }); return original(...args); });
    await expect(s.check(s.fingerprint())).rejects.toMatchObject({ code: "changed" });
  });
  it("does not mark an expired fallback OK when a failed renewal crosses its expiry", async () => {
    vi.useFakeTimers(); const s = setup();
    const key = `${WSAA_HOMOLOGACION_URL}:${s.fingerprint()}`;
    for (const service of ["wsfe", "ws_sr_constancia_inscripcion"]) s.entries.set(`${key}:${service}`, { token: "OLD", sign: "OLD", issuedAt: Date.now() - 180000, expiresAt: Date.now() + 1000 });
    s.fetchFn.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 2000)); throw new Error("timeout"); });
    const pending = s.check(s.fingerprint()); await vi.advanceTimersByTimeAsync(2100);
    expect((await pending).services.every(result => result.status !== "ok")).toBe(true);
  });
  it("does not memoize successful reports beyond the returned ticket expiry", async () => {
    vi.useFakeTimers(); const s = setup(); const key = `${WSAA_HOMOLOGACION_URL}:${s.fingerprint()}`;
    for (const service of ["wsfe", "ws_sr_constancia_inscripcion"]) s.entries.set(`${key}:${service}`, { token: "OLD", sign: "OLD", issuedAt: Date.now(), expiresAt: Date.now() + 1000 });
    expect((await s.check(s.fingerprint())).services.every(result => result.status === "ok")).toBe(true); expect(s.fetchFn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1100);
    await s.check(s.fingerprint()); expect(s.fetchFn).toHaveBeenCalledTimes(2);
  });
  it("bounds per-call hangs and reports each timeout without leaking details", async () => {
    vi.useFakeTimers(); const s = setup(); s.fetchFn.mockImplementation((_url, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(new DOMException("SECRET", "TimeoutError"))); }));
    const pending = s.check(s.fingerprint()); await vi.advanceTimersByTimeAsync(4100);
    expect((await pending).services.map(r => r.status)).toEqual(["timeout", "timeout"]);
  });
  it("bounds the total operation even when persistence hangs", async () => {
    vi.useFakeTimers(); const s = setup(); s.repository.get.mockImplementation(() => new Promise(() => {}));
    const pending = s.check(s.fingerprint()); const assertion = expect(pending).rejects.toBeInstanceOf(ConnectionCheckError);
    await vi.advanceTimersByTimeAsync(10100); await assertion; expect(s.fetchFn).not.toHaveBeenCalled();
  });
});
