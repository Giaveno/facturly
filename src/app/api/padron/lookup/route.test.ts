import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/auth/session", async original => ({ ...await original<typeof import("@/lib/auth/session")>(), requireAccountantSession: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/lib/padron/lookup", async original => ({ ...await original<typeof import("@/lib/padron/lookup")>(), lookupCuit: vi.fn() }));
import { requireAccountantSession, UnauthorizedError } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { lookupCuit, PadronLookupError } from "@/lib/padron/lookup";
import { POST } from "./route";
const fingerprint = "a".repeat(64);
const req = (origin = "https://app.example.com", body: unknown = { cuit: "30-71014576-4", fingerprint }) => new Request("https://app.example.com/api/padron/lookup", { method: "POST", headers: { host: "app.example.com", origin }, body: JSON.stringify(body) });
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("ARCA_ENV", "homologacion"); vi.mocked(requireAccountantSession).mockResolvedValue(); });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
it("requires same origin and authentication before DB", async () => {
  for (const origin of ["https://evil.example.com", ""]) expect((await POST(req(origin))).status).toBe(403);
  expect(requireAccountantSession).not.toHaveBeenCalled();
  vi.mocked(requireAccountantSession).mockRejectedValue(new UnauthorizedError()); expect((await POST(req())).status).toBe(401); expect(getDb).not.toHaveBeenCalled();
});
it.each(["production", "invalid", ""])('rejects %s before DB/network', async env => {
  vi.stubEnv("ARCA_ENV", env); expect((await POST(req())).status).toBe(409); expect(getDb).not.toHaveBeenCalled(); expect(lookupCuit).not.toHaveBeenCalled();
});
it("validates exact target+fingerprint contract, no request-controlled represented CUIT/services/endpoints", async () => {
  for (const body of [{}, { cuit: "bad", fingerprint }, { cuit: "30710145765", fingerprint }, { cuit: "abc30710145764", fingerprint }, { cuit: "30710145764", fingerprint: "bad" }, { cuit: "30710145764", fingerprint, cuitRepresentada: "20123456786" }, { cuit: "30710145764", fingerprint, url: "https://evil" }]) expect((await POST(req(undefined, body))).status).toBe(400);
  expect(lookupCuit).not.toHaveBeenCalled(); expect(getDb).not.toHaveBeenCalled();
});
it("passes normalized lookup target and returns uncached response", async () => {
  vi.mocked(lookupCuit).mockResolvedValue({ cuit: "30710145764", fingerprint, environment: "homologacion", checkedAt: "2026-01-01T00:00:00Z", authentication: "authenticated", dataResponse: "received", status: "found", condition: "ri", reason: "explicit_tax" });
  const res = await POST(req()); expect(res.status).toBe(200); expect(res.headers.get("cache-control")).toContain("no-store"); expect(lookupCuit).toHaveBeenCalledWith({}, process.env, "30710145764", fingerprint);
});
it("bounds oversized, malformed and unfinished request streams before DB access", async () => {
  expect((await POST(req(undefined, "x".repeat(1025)))).status).toBe(400);
  vi.useFakeTimers(); const cancel = vi.fn();
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"cuit":')); }, cancel });
  const request = new Request("https://app.example.com/api/padron/lookup", { method: "POST", headers: { host: "app.example.com", origin: "https://app.example.com" }, body, duplex: "half" } as RequestInit);
  const pending = POST(request); await vi.advanceTimersByTimeAsync(2100); const response = await pending;
  expect(response.status).toBe(408); expect(await response.json()).toMatchObject({ code: "timeout" }); expect(cancel).toHaveBeenCalled(); expect(getDb).not.toHaveBeenCalled(); expect(lookupCuit).not.toHaveBeenCalled();
});
it("maps fixed safe errors and bounded diagnostic without raw provider text/logs", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const [code, status] of [["credentials", 409], ["changed", 409], ["timeout", 504], ["cooldown", 429], ["upstream", 502]] as const) {
      vi.mocked(lookupCuit).mockRejectedValue(new PadronLookupError(code, { stage: "padron", category: "provider-errors", providerCodes: [602] }));
      const res = await POST(req()); expect(res.status).toBe(status); expect(await res.json()).toMatchObject({ code, diagnostic: { stage: "padron", category: "provider-errors", providerCodes: [602] } });
    }
    vi.mocked(lookupCuit).mockRejectedValue(new Error("SECRET_TOKEN PRIVATE KEY faultstring")); const res = await POST(req());
    expect(res.status).toBe(500); expect(await res.text()).not.toMatch(/SECRET|PRIVATE|faultstring/); expect(log).not.toHaveBeenCalled();
  } finally { log.mockRestore(); }
});
it("returns only the allowlisted SOAP Fault subtype with HTTP status and a reference", async () => {
  vi.mocked(lookupCuit).mockRejectedValue(new PadronLookupError("upstream", { stage: "padron", category: "soap-fault", httpStatus: 500, faultReason: "validation-rejected" }));
  const res = await POST(req());
  expect(res.status).toBe(502);
  expect(await res.json()).toMatchObject({ diagnostic: { stage: "padron", category: "soap-fault", httpStatus: 500, faultReason: "validation-rejected" }, correlationId: expect.stringMatching(/^[a-f0-9-]{36}$/) });
});
