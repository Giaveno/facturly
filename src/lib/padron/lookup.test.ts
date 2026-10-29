import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { generateSelfSignedCert } from "@/test-support/pkcs7";
import { inspectCertificate } from "@/lib/credentials/pem";
import { encryptPrivateKey, deriveAesKey } from "@/lib/db/credentials";
import type { StoredCredentials } from "@/lib/db/credentials-repository";
import type { TaCacheEntry } from "@/adapters/arca/ta-cache";
import { ARCA_SERVICE_PADRON, PADRON_HOMOLOGACION_URL, WSAA_HOMOLOGACION_URL } from "@/adapters/arca/constants";
import { createPadronLookup, normalizeLookupCuit } from "./lookup";

const AES = "01".repeat(32);
const target = "30710145764";
let pair: ReturnType<typeof generateSelfSignedCert>;
let other: ReturnType<typeof generateSelfSignedCert>;
let noCuit: ReturnType<typeof generateSelfSignedCert>;
beforeAll(() => { pair = generateSelfSignedCert("CUIT 20123456786"); other = generateSelfSignedCert("OTHER CUIT 20123456786"); noCuit = generateSelfSignedCert("TEST"); });
afterEach(() => vi.useRealTimers());
const xml = `<Envelope><Body><getPersona_v2Response><personaReturn><datosGenerales><idPersona>${target}</idPersona><razonSocial>TEST SA</razonSocial></datosGenerales><datosRegimenGeneral><impuesto><idImpuesto>30</idImpuesto><estadoImpuesto>AC</estadoImpuesto></impuesto></datosRegimenGeneral></personaReturn></getPersona_v2Response></Body></Envelope>`;
function setup(env: Record<string, string | undefined> = { ARCA_ENV: "homologacion", AES_KEY: AES }) {
  let stored: StoredCredentials | null = { certPem: pair.certPem, encryptedKey: encryptPrivateKey(pair.keyPem, deriveAesKey(AES)) };
  const fingerprint = inspectCertificate(pair.certPem).fingerprint;
  const repository = { get: vi.fn(async () => stored) };
  const entries = new Map<string, TaCacheEntry>([[`${WSAA_HOMOLOGACION_URL}:${fingerprint}:${ARCA_SERVICE_PADRON}`, { token: "SECRET_TOKEN", sign: "SECRET_SIGN", expiresAt: Date.now() + 3600000, issuedAt: Date.now() }]]);
  const store = { get: vi.fn(async (key: string) => entries.get(key) ?? null), put: vi.fn(async (key: string, value: TaCacheEntry) => { entries.set(key, value); }) };
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(xml));
  const lookup = createPadronLookup({ repository, store, env, fetchFn });
  return { lookup, repository, entries, store, fetchFn, fingerprint, replace: (value: typeof stored) => { stored = value; } };
}
describe("homologation-only CUIT lookup", () => {
  it("normalizes only spaces/hyphens and validates checksum", () => {
    expect(normalizeLookupCuit("30 - 71014576 - 4")).toBe(target);
    for (const value of ["abc30710145764", "30710145765", "30.71014576.4", "", "9".repeat(200)]) expect(normalizeLookupCuit(value)).toBeNull();
  });
  it.each([undefined, "production", "invalid", ""])('rejects environment %s before credentials/store/network', async env => {
    const s = setup({ ARCA_ENV: env }); await expect(s.lookup(target, s.fingerprint)).rejects.toMatchObject({ code: "environment" });
    expect(s.repository.get).not.toHaveBeenCalled(); expect(s.store.get).not.toHaveBeenCalled(); expect(s.fetchFn).not.toHaveBeenCalled();
  });
  it("uses certificate CUIT as represented identity and requested target only as idPersona; no fiscal writes", async () => {
    const s = setup(); const result = await s.lookup("30-71014576-4", s.fingerprint);
    expect(result).toMatchObject({ cuit: target, environment: "homologacion", fingerprint: s.fingerprint, authentication: "authenticated", dataResponse: "received", status: "found", condition: "ri" });
    const [url, init] = s.fetchFn.mock.calls[0]!; expect(url).toBe(PADRON_HOMOLOGACION_URL);
    expect(init).toMatchObject({ method: "POST", redirect: "error", cache: "no-store" });
    expect(init?.headers).toEqual({ "Content-Type": "text/xml; charset=utf-8", SOAPAction: "" });
    expect(init?.body).toContain("<cuitRepresentada>20123456786</cuitRepresentada>"); expect(init?.body).toContain(`<idPersona>${target}</idPersona>`);
    expect(init?.body).toContain("<a5:getPersona_v2>");
    expect(init?.body).not.toMatch(/FECAE|FEParam|production/); expect(s.store.put).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toMatch(/SECRET|BEGIN|certPem|encryptedKey/);
  });
  it("deduplicates in-flight/results and applies a credential-wide cooldown for other targets", async () => {
    const s = setup(); await Promise.all([s.lookup(target, s.fingerprint), s.lookup(target, s.fingerprint)]); await s.lookup(target, s.fingerprint);
    expect(s.fetchFn).toHaveBeenCalledTimes(1);
    await expect(s.lookup("20123456786", s.fingerprint)).rejects.toMatchObject({ code: "cooldown" });
  });
  it("rejects absent/changed/bad credentials and invalid target without a network call", async () => {
    for (const kind of ["absent", "changed", "encrypted", "target"]) {
      const s = setup(); if (kind === "absent") s.replace(null);
      if (kind === "encrypted") s.replace({ certPem: pair.certPem, encryptedKey: encryptPrivateKey(pair.keyPem, deriveAesKey("02".repeat(32))) });
      await expect(s.lookup(kind === "target" ? "bad" : target, kind === "changed" ? "a".repeat(64) : s.fingerprint)).rejects.toMatchObject({ code: kind === "changed" ? "changed" : kind === "target" ? "invalid_cuit" : "credentials" });
      expect(s.fetchFn).not.toHaveBeenCalled();
    }
  });
  it("rejects credentials changing while the response is in flight", async () => {
    const s = setup(); s.fetchFn.mockImplementation(async () => { s.replace(null); return new Response(xml); });
    await expect(s.lookup(target, s.fingerprint)).rejects.toMatchObject({ code: "changed" });
  });
  it.each(["no_cuit", "expired", "not_yet_valid", "key_mismatch"])('rejects unusable certificate %s before network', async kind => {
    const s = setup();
    if (kind === "expired" || kind === "not_yet_valid") {
      vi.useFakeTimers(); vi.setSystemTime(Date.now() + (kind === "expired" ? 366 : -2) * 86400000);
    }
    const cert = kind === "no_cuit" ? noCuit : pair;
    const keyPem = kind === "key_mismatch" ? other.keyPem : cert.keyPem;
    s.replace({ certPem: cert.certPem, encryptedKey: encryptPrivateKey(keyPem, deriveAesKey(AES)) });
    await expect(s.lookup(target, inspectCertificate(cert.certPem).fingerprint)).rejects.toMatchObject({ code: "credentials" });
    expect(s.fetchFn).not.toHaveBeenCalled(); expect(s.store.get).not.toHaveBeenCalled();
  });
  it("does not reuse WSFE, production, unscoped, or previous-certificate tickets", async () => {
    const s = setup(); const entry = [...s.entries.values()][0]!; s.entries.clear();
    for (const key of ["ws_sr_constancia_inscripcion", `${WSAA_HOMOLOGACION_URL}:${s.fingerprint}:wsfe`, `https://wsaa.afip.gov.ar/ws/services/LoginCms:${s.fingerprint}:${ARCA_SERVICE_PADRON}`, `${WSAA_HOMOLOGACION_URL}:${inspectCertificate(other.certPem).fingerprint}:${ARCA_SERVICE_PADRON}`]) s.entries.set(key, entry);
    s.fetchFn.mockResolvedValue(new Response("<broken>"));
    await expect(s.lookup(target, s.fingerprint)).rejects.toMatchObject({ diagnostic: { stage: "wsaa" } });
    expect(s.fetchFn).toHaveBeenCalledTimes(1); expect(s.fetchFn.mock.calls[0]![0]).toBe(WSAA_HOMOLOGACION_URL);
  });
  it("authenticates a cold scoped TA once, persists only that ticket, then queries without emission", async () => {
    const s = setup(); s.entries.clear();
    s.fetchFn.mockImplementation(async url => {
      if (url !== WSAA_HOMOLOGACION_URL) return new Response(xml);
      const ticket = `<loginTicketResponse><header><expirationTime>${new Date(Date.now() + 3600000).toISOString()}</expirationTime></header><credentials><token>NEW_SECRET</token><sign>NEW_SIGN</sign></credentials></loginTicketResponse>`;
      return new Response(`<Envelope><Body><loginCmsResponse><loginCmsReturn><![CDATA[${ticket}]]></loginCmsReturn></loginCmsResponse></Body></Envelope>`);
    });
    await Promise.all([s.lookup(target, s.fingerprint), s.lookup(target, s.fingerprint)]);
    expect(s.fetchFn.mock.calls.map(([url]) => url)).toEqual([WSAA_HOMOLOGACION_URL, PADRON_HOMOLOGACION_URL]);
    expect(s.store.put).toHaveBeenCalledTimes(1); expect(s.store.put.mock.calls[0]![0]).toBe(`${WSAA_HOMOLOGACION_URL}:${s.fingerprint}:${ARCA_SERVICE_PADRON}`);
  });
  it("invalidates deduplicated results at ticket expiry and bounds hanging provider bodies", async () => {
    vi.useFakeTimers(); const s = setup(); for (const entry of s.entries.values()) entry.expiresAt = Date.now() + 1000;
    await s.lookup(target, s.fingerprint); await vi.advanceTimersByTimeAsync(1100);
    s.fetchFn.mockResolvedValue(new Response("<broken>"));
    await expect(s.lookup(target, s.fingerprint)).rejects.toMatchObject({ diagnostic: { stage: "wsaa" } });
    const hung = setup(); const cancel = vi.fn(); hung.fetchFn.mockImplementation(async () => new Response(new ReadableStream({ start() {}, cancel })));
    const pending = expect(hung.lookup(target, hung.fingerprint)).rejects.toMatchObject({ code: "timeout", diagnostic: { stage: "padron", category: "timeout" } });
    await vi.advanceTimersByTimeAsync(4100); await pending; expect(cancel).toHaveBeenCalled();
  });
  it("does not reuse an old attempt after credential rotation", async () => {
    const s = setup(); await s.lookup(target, s.fingerprint);
    s.replace({ certPem: other.certPem, encryptedKey: encryptPrivateKey(other.keyPem, deriveAesKey(AES)) });
    const fingerprint = inspectCertificate(other.certPem).fingerprint;
    s.entries.set(`${WSAA_HOMOLOGACION_URL}:${fingerprint}:${ARCA_SERVICE_PADRON}`, [...s.entries.values()][0]!);
    const result = await s.lookup(target, fingerprint); expect(result.fingerprint).toBe(fingerprint); expect(s.fetchFn).toHaveBeenCalledTimes(2);
  });
  it.each([["<Envelope><Body><Fault><faultstring>SECRET</faultstring></Fault></Body></Envelope>", 500, "soap-fault"], ["<broken>", 200, "malformed-response"], ["SECRET", 403, "http"], ["x".repeat(1_048_577), 200, "response-too-large"]])("sanitizes upstream errors", async (body, status, category) => {
    const s = setup(); s.fetchFn.mockResolvedValue(new Response(body, { status }));
    try { await s.lookup(target, s.fingerprint); throw new Error("expected failure"); } catch (error) {
      expect(error).toMatchObject({ code: "upstream", diagnostic: { stage: "padron", category } }); expect(JSON.stringify(error)).not.toMatch(/SECRET|faultstring|PRIVATE/);
    }
  });
  it.each([200, 500])("preserves safe SOAP Fault subtype and HTTP %s without guessing from messages", async status => {
    for (const [detail, faultReason] of [["<detail><a5:SRValidationException xmlns:a5=\"http://a5.soap.ws.server.puc.sr/\"/></detail>", "validation-rejected"], ["", "unclassified"]]) {
      const s = setup();
      s.fetchFn.mockResolvedValue(new Response(`<Envelope><Body><Fault><faultstring>SECRET_TOKEN permission denied expired</faultstring>${detail}</Fault></Body></Envelope>`, { status }));
      await expect(s.lookup(target, s.fingerprint)).rejects.toMatchObject({ diagnostic: { stage: "padron", category: "soap-fault", httpStatus: status, faultReason } });
    }
  });
  it("separates WSAA failure and refuses expired TA without querying Padrón", async () => {
    const s = setup(); for (const entry of s.entries.values()) entry.expiresAt = Date.now() - 1;
    s.fetchFn.mockResolvedValue(new Response("<broken>"));
    await expect(s.lookup(target, s.fingerprint)).rejects.toMatchObject({ diagnostic: { stage: "wsaa", category: "malformed-response" } });
    expect(s.fetchFn.mock.calls.every(([url]) => url === WSAA_HOMOLOGACION_URL)).toBe(true);
  });
  it("bounds hanging requests and persistence", async () => {
    vi.useFakeTimers();
    const s = setup(); s.fetchFn.mockImplementation(() => new Promise(() => {}));
    const pending = expect(s.lookup(target, s.fingerprint)).rejects.toMatchObject({ code: "timeout", diagnostic: { stage: "padron", category: "timeout" } });
    await vi.advanceTimersByTimeAsync(4100); await pending;
    const db = setup(); db.repository.get.mockImplementation(() => new Promise(() => {}));
    const pendingDb = expect(db.lookup(target, db.fingerprint)).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(10100); await pendingDb; expect(db.fetchFn).not.toHaveBeenCalled();
  });
});
