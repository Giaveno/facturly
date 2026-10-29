import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { generateSelfSignedCert } from "@/test-support/pkcs7";
import { inspectCertificate } from "@/lib/credentials/pem";
import { encryptPrivateKey, deriveAesKey } from "@/lib/db/credentials";
import type { StoredCredentials } from "@/lib/db/credentials-repository";
import type { TaCacheEntry } from "@/adapters/arca/ta-cache";
import { WSAA_HOMOLOGACION_URL, WSFE_HOMOLOGACION_URL } from "@/adapters/arca/constants";
import { createPointsOfSaleChecker } from "./points-of-sale";

const AES = "01".repeat(32);
let pair: ReturnType<typeof generateSelfSignedCert>;
let other: ReturnType<typeof generateSelfSignedCert>;
beforeAll(() => { pair = generateSelfSignedCert("TEST"); other = generateSelfSignedCert("OTHER"); });
afterEach(() => vi.useRealTimers());
const xml = `<Envelope><Body><FEParamGetPtosVentaResponse><FEParamGetPtosVentaResult><ResultGet><PtoVenta><Nro>12345</Nro><EmisionTipo>CAE</EmisionTipo><Bloqueado>N</Bloqueado></PtoVenta></ResultGet></FEParamGetPtosVentaResult></FEParamGetPtosVentaResponse></Body></Envelope>`;
function setup(env: Record<string, string | undefined> = { ARCA_ENV: "homologacion", AES_KEY: AES, EMISSIONS_ENABLED: "false" }) {
  let client: { id: string; cuit: string; ptoVta: number; razonSocial: string; condicionIva: string } | null = { id: "client", cuit: "30710145764", ptoVta: 12345, razonSocial: "TEST", condicionIva: "monotributista" };
  let stored: StoredCredentials | null = { certPem: pair.certPem, encryptedKey: encryptPrivateKey(pair.keyPem, deriveAesKey(AES)) };
  const fingerprint = inspectCertificate(pair.certPem).fingerprint;
  const repository = { get: vi.fn(async () => stored) };
  const getClient = vi.fn(async (id: string) => client ? { ...client, id } : null);
  const entries = new Map<string, TaCacheEntry>([[`${WSAA_HOMOLOGACION_URL}:${fingerprint}:wsfe`, { token: "SECRET_TOKEN", sign: "SECRET_SIGN", expiresAt: Date.now() + 3600000, issuedAt: Date.now() }]]);
  const store = { get: vi.fn(async (key: string) => entries.get(key) ?? null), put: vi.fn(async (key: string, entry: TaCacheEntry) => { entries.set(key, entry); }) };
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(xml));
  const check = createPointsOfSaleChecker({ repository, getClient, store, env, fetchFn });
  return { check, repository, getClient, fetchFn, store, entries, fingerprint, env, setClient: (next: typeof client) => { client = next; }, edit: (patch: Partial<NonNullable<typeof client>>) => { client = { ...client!, ...patch }; }, replace: (next: typeof stored) => { stored = next; } };
}
describe("stored client homologation point-of-sale query", () => {
  it.each(["production", "", undefined, "invalid"])("rejects %s before credentials, client or network", async value => {
    const s = setup({ ARCA_ENV: value }); await expect(s.check("client", s.fingerprint)).rejects.toMatchObject({ code: "environment" });
    expect(s.repository.get).not.toHaveBeenCalled(); expect(s.getClient).not.toHaveBeenCalled(); expect(s.fetchFn).not.toHaveBeenCalled();
  });
  it("uses only stored CUIT and trusted endpoint, reuses durable TA, works with emissions disabled", async () => {
    const s = setup(); const result = await s.check("client", s.fingerprint);
    expect(result).toMatchObject({ environment: "homologacion", client: { cuit: "30710145764", ptoVta: 12345 }, fingerprint: s.fingerprint, configuredPoint: "available_cae" });
    expect(s.fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = s.fetchFn.mock.calls[0]!; expect(url).toBe(WSFE_HOMOLOGACION_URL); expect(init).toMatchObject({ redirect: "error", cache: "no-store", method: "POST" });
    expect(init?.body).toContain("<ar:Cuit>30710145764</ar:Cuit>"); expect(init?.body).not.toMatch(/FECAESolicitar|FECAEARegInformativo/);
    expect(JSON.stringify(result)).not.toMatch(/SECRET|PRIVATE|BEGIN|encryptedKey|certPem/); expect(s.store.put).not.toHaveBeenCalled();
  });
  it("shares in-flight queries and briefly reuses same identity only", async () => {
    const s = setup(); const [a, b] = await Promise.all([s.check("client", s.fingerprint), s.check("client", s.fingerprint)]);
    expect(a).toEqual(b); await s.check("client", s.fingerprint); expect(s.fetchFn).toHaveBeenCalledTimes(1);
    s.edit({ ptoVta: 1 }); expect((await s.check("client", s.fingerprint)).configuredPoint).toBe("not_returned"); expect(s.fetchFn).toHaveBeenCalledTimes(2);
    s.replace({ certPem: other.certPem, encryptedKey: encryptPrivateKey(other.keyPem, deriveAesKey(AES)) });
    await expect(s.check("client", s.fingerprint)).rejects.toMatchObject({ code: "changed" }); expect(s.fetchFn).toHaveBeenCalledTimes(2);
  });
  it("shares a cold WSAA refresh across concurrent different-client queries", async () => {
    const s = setup(); s.entries.clear();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const login = vi.fn(async () => {
      await gate;
      const ticket = `<loginTicketResponse><header><expirationTime>${new Date(Date.now() + 3600000).toISOString()}</expirationTime></header><credentials><token>SHARED_TOKEN</token><sign>SHARED_SIGN</sign></credentials></loginTicketResponse>`;
      return new Response(`<Envelope><Body><loginCmsResponse><loginCmsReturn><![CDATA[${ticket}]]></loginCmsReturn></loginCmsResponse></Body></Envelope>`);
    });
    s.fetchFn.mockImplementation(async url => url === WSAA_HOMOLOGACION_URL ? login() : new Response(xml));
    const pending = Promise.all([s.check("first-client", s.fingerprint), s.check("second-client", s.fingerprint)]);
    // Both attempts must reach the cache before allowing the first LoginCms to finish.
    await vi.waitFor(() => expect(login).toHaveBeenCalled());
    release();
    const [first, second] = await pending;
    expect(login).toHaveBeenCalledTimes(1);
    expect(first.client.id).toBe("first-client"); expect(second.client.id).toBe("second-client");
    expect(s.fetchFn.mock.calls.filter(([url]) => url === WSFE_HOMOLOGACION_URL)).toHaveLength(2);
  });
  it.each(["client", "credentials", "encrypted", "fingerprint"])("fails safely for missing/invalid %s", async kind => {
    const s = setup(); if (kind === "client") s.setClient(null); if (kind === "credentials") s.replace(null);
    if (kind === "encrypted") s.replace({ certPem: pair.certPem, encryptedKey: encryptPrivateKey(pair.keyPem, deriveAesKey("02".repeat(32))) });
    await expect(s.check("client", kind === "fingerprint" ? "a".repeat(64) : s.fingerprint)).rejects.toMatchObject({ code: kind === "client" ? "not_found" : kind === "fingerprint" ? "changed" : "credentials" });
    expect(s.fetchFn).not.toHaveBeenCalled();
  });
  it.each(["client", "deleted", "certificate", "key"])("discards stale response after %s changes", async kind => {
    const s = setup(); s.fetchFn.mockImplementation(async () => {
      if (kind === "client") s.edit({ cuit: "20123456786" }); if (kind === "deleted") s.setClient(null);
      if (kind === "certificate") s.replace({ certPem: other.certPem, encryptedKey: encryptPrivateKey(other.keyPem, deriveAesKey(AES)) });
      if (kind === "key") s.replace({ certPem: pair.certPem, encryptedKey: encryptPrivateKey(pair.keyPem, deriveAesKey(AES)) });
      return new Response(xml);
    });
    await expect(s.check("client", s.fingerprint)).rejects.toMatchObject({ code: "changed" });
  });
  it.each([["CAEA", "N", "", "not_available_cae"], ["CAE", "S", "", "not_available_cae"], ["CAE", "N", "<FchBaja>20261028</FchBaja>", "not_available_cae"], ["?", "N", "", "unverified"]])("does not approve configured %s / %s / %s", async (type, blocked, date, status) => {
    const s = setup(); s.fetchFn.mockResolvedValue(new Response(xml.replace("<EmisionTipo>CAE", `<EmisionTipo>${type}`).replace("<Bloqueado>N</Bloqueado>", `<Bloqueado>${blocked}</Bloqueado>${date}`)));
    expect((await s.check("client", s.fingerprint)).configuredPoint).toBe(status);
  });
  it("sanitizes upstream errors and cools down failures", async () => {
    const s = setup(); const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      s.fetchFn.mockRejectedValue(new Error("SECRET_TOKEN PRIVATE KEY"));
      for (let i = 0; i < 2; i++) await expect(s.check("client", s.fingerprint)).rejects.toMatchObject({ code: "upstream", message: "upstream" });
      expect(s.fetchFn).toHaveBeenCalledTimes(1); expect(log).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
  it.each(["wsaa", "wsfe"] as const)("preserves safe %s HTTP diagnostics without upstream text", async stage => {
    const s = setup(); if (stage === "wsaa") s.entries.clear();
    s.fetchFn.mockResolvedValue(new Response("SECRET_TOKEN PRIVATE KEY", { status: 503 }));
    await expect(s.check("client", s.fingerprint)).rejects.toMatchObject({ code: "upstream", diagnostic: { stage, category: "http", httpStatus: 503 } });
  });
  it.each(["wsaa", "wsfe"] as const)("classifies %s SOAP faults, not authorization guesses", async stage => {
    const s = setup(); if (stage === "wsaa") s.entries.clear();
    s.fetchFn.mockResolvedValue(new Response("<Envelope><Body><Fault><faultcode>SECRET</faultcode><faultstring>PRIVATE KEY</faultstring></Fault></Body></Envelope>", { status: 500 }));
    await expect(s.check("client", s.fingerprint)).rejects.toMatchObject({ diagnostic: { stage, category: "soap-fault", httpStatus: 500 } });
  });
  it("preserves numeric provider errors and treats an empty result as a successful read only", async () => {
    const s = setup();
    s.fetchFn.mockResolvedValue(new Response(xml.replace(/<ResultGet>.*<\/ResultGet>/, "<Errors><Err><Code>602</Code><Msg>SECRET</Msg></Err><Err><Code>SECRET_SIGN</Code></Err></Errors>")));
    await expect(s.check("client", s.fingerprint)).rejects.toMatchObject({ diagnostic: { stage: "wsfe", category: "provider-errors", providerCodes: [602] } });
    const empty = setup(); empty.fetchFn.mockResolvedValue(new Response(xml.replace(/<ResultGet>.*<\/ResultGet>/, "<ResultGet/>")));
    expect(await empty.check("client", empty.fingerprint)).toMatchObject({ points: [], configuredPoint: "not_returned" });
  });
  it("retains numeric codes alongside non-2xx HTTP status for SOAP faults and provider errors", async () => {
    const fault = setup(); fault.entries.clear(); fault.fetchFn.mockResolvedValue(new Response("<Envelope><Body><Fault><faultcode>123</faultcode><faultstring>SECRET</faultstring></Fault></Body></Envelope>", { status: 500 }));
    await expect(fault.check("client", fault.fingerprint)).rejects.toMatchObject({ diagnostic: { stage: "wsaa", category: "soap-fault", httpStatus: 500, providerCodes: [123] } });
    const provider = setup(); provider.fetchFn.mockResolvedValue(new Response(xml.replace(/<ResultGet>.*<\/ResultGet>/, "<Errors><Err><Code>602</Code><Msg>SECRET</Msg></Err></Errors>"), { status: 500 }));
    await expect(provider.check("client", provider.fingerprint)).rejects.toMatchObject({ diagnostic: { stage: "wsfe", category: "provider-errors", httpStatus: 500, providerCodes: [602] } });
  });
  it("distinguishes network, malformed response and WSFE timeout safely", async () => {
    const s = setup(); s.fetchFn.mockRejectedValue(new Error("SECRET"));
    await expect(s.check("client", s.fingerprint)).rejects.toMatchObject({ diagnostic: { stage: "wsfe", category: "network" } });
    const bad = setup(); bad.fetchFn.mockResolvedValue(new Response("<broken>"));
    await expect(bad.check("client", bad.fingerprint)).rejects.toMatchObject({ diagnostic: { stage: "wsfe", category: "malformed-response" } });
    vi.useFakeTimers(); const hung = setup(); hung.fetchFn.mockImplementation(() => new Promise(() => {}));
    const pending = expect(hung.check("client", hung.fingerprint)).rejects.toMatchObject({ code: "timeout", diagnostic: { stage: "wsfe", category: "timeout" } });
    await vi.advanceTimersByTimeAsync(25100); await pending;
  });
  it("classifies malformed WSAA responses without confusing a cache failure with provider data", async () => {
    const malformed = setup(); malformed.entries.clear(); malformed.fetchFn.mockResolvedValue(new Response("<broken>"));
    await expect(malformed.check("client", malformed.fingerprint)).rejects.toMatchObject({ diagnostic: { stage: "wsaa", category: "malformed-response" } });
    const persistence = setup(); persistence.store.get.mockRejectedValue(new Error("SECRET"));
    await expect(persistence.check("client", persistence.fingerprint)).rejects.toMatchObject({ diagnostic: { stage: "wsaa", category: "internal" } });
  });
  it("preserves the independent WSAA acquisition timeout category", async () => {
    vi.useFakeTimers(); const s = setup(); s.store.get.mockImplementation(() => new Promise(() => {}));
    const pending = expect(s.check("client", s.fingerprint)).rejects.toMatchObject({ code: "timeout", diagnostic: { stage: "wsaa", category: "timeout" } });
    await vi.advanceTimersByTimeAsync(30100); await pending;
  });
  it("bounds response size before parsing", async () => {
    const s = setup(); s.fetchFn.mockResolvedValue(new Response("x".repeat(1_048_577)));
    await expect(s.check("client", s.fingerprint)).rejects.toMatchObject({ code: "upstream" });
  });
  it("bounds hung network and response-body reads", async () => {
    vi.useFakeTimers(); const s = setup(); s.fetchFn.mockImplementation(async () => new Response(new ReadableStream({ start() {} })));
    const pending = expect(s.check("client", s.fingerprint)).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(25100); await pending;
  });
  it("bounds total operation even if persistence ignores abort", async () => {
    vi.useFakeTimers(); const s = setup(); s.getClient.mockImplementation(() => new Promise(() => {}));
    const pending = expect(s.check("client", s.fingerprint)).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(65100); await pending; expect(s.fetchFn).not.toHaveBeenCalled();
  });
  it("does not return successful results after the ticket expires in flight", async () => {
    vi.useFakeTimers(); const s = setup(); s.entries.set(`${WSAA_HOMOLOGACION_URL}:${s.fingerprint}:wsfe`, { token: "T", sign: "S", issuedAt: Date.now(), expiresAt: Date.now() + 1000 });
    s.fetchFn.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 1500)); return new Response(xml); });
    const pending = expect(s.check("client", s.fingerprint)).rejects.toMatchObject({ code: "upstream" }); await vi.advanceTimersByTimeAsync(1600); await pending;
  });
});
