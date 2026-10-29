import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/auth/session", async original => ({ ...await original<typeof import("@/lib/auth/session")>(), requireAccountantSession: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/lib/clients/points-of-sale", async original => ({ ...await original<typeof import("@/lib/clients/points-of-sale")>(), checkClientPointsOfSale: vi.fn() }));
import { requireAccountantSession, UnauthorizedError } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { checkClientPointsOfSale, PointsOfSaleError } from "@/lib/clients/points-of-sale";
import { POST } from "./route";
const id = "11111111-1111-4111-8111-111111111111";
const fingerprint = "a".repeat(64);
const req = (origin = "https://app.example.com", body: unknown = { fingerprint }) => new Request(`https://app.example.com/api/clients/${id}/points-of-sale`, { method: "POST", headers: { host: "app.example.com", origin }, body: JSON.stringify(body) });
const context = (value = id) => ({ params: Promise.resolve({ id: value }) });
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("ARCA_ENV", "homologacion"); vi.mocked(requireAccountantSession).mockResolvedValue(); });
afterEach(() => vi.unstubAllEnvs());
it("requires valid UUID, explicit same origin and accountant authentication before database", async () => {
  expect((await POST(req(), context("invalid"))).status).toBe(400);
  for (const origin of ["https://evil.example.com", ""]) expect((await POST(req(origin), context())).status).toBe(403);
  expect(requireAccountantSession).not.toHaveBeenCalled();
  vi.mocked(requireAccountantSession).mockRejectedValue(new UnauthorizedError()); expect((await POST(req(), context())).status).toBe(401);
  expect(getDb).not.toHaveBeenCalled(); expect(checkClientPointsOfSale).not.toHaveBeenCalled();
});
it.each(["production", "invalid", ""])("rejects %s environment before database", async value => {
  vi.stubEnv("ARCA_ENV", value); const response = await POST(req(), context()); expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "environment" });
  expect(getDb).not.toHaveBeenCalled(); expect(checkClientPointsOfSale).not.toHaveBeenCalled();
});
it("accepts only public certificate identity, never arbitrary CUIT/URL/service or PV", async () => {
  for (const body of [null, {}, [], { fingerprint: "invalid" }, { fingerprint, cuit: "30710145764" }, { fingerprint, url: "https://evil" }, { fingerprint, service: "wsfe" }, { fingerprint, ptoVta: 1 }]) expect((await POST(req(undefined, body), context())).status).toBe(400);
  expect(checkClientPointsOfSale).not.toHaveBeenCalled();
});
it("returns only the safe report with no-store and never changes client fields", async () => {
  const report = { environment: "homologacion" as const, fingerprint, client: { id, cuit: "30710145764", ptoVta: 1, razonSocial: "TEST", condicionIva: "ri" }, checkedAt: new Date().toISOString(), points: [], configuredPoint: "not_returned" as const };
  vi.mocked(checkClientPointsOfSale).mockResolvedValue(report);
  const res = await POST(req(), context()); expect(res.status).toBe(200); expect(await res.json()).toEqual(report); expect(res.headers.get("cache-control")).toBe("no-store");
  expect(checkClientPointsOfSale).toHaveBeenCalledWith({}, process.env, id, fingerprint);
});
it("maps failures safely, never returning or logging raw upstream errors", async () => {
  for (const [code, status] of [["not_found", 404], ["credentials", 409], ["changed", 409], ["environment", 409], ["timeout", 504], ["cooldown", 429], ["upstream", 502]] as const) {
    vi.mocked(checkClientPointsOfSale).mockRejectedValue(new PointsOfSaleError(code));
    const res = await POST(req(), context()); expect(res.status).toBe(status); expect(res.headers.get("cache-control")).toBe("no-store");
  }
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    vi.mocked(checkClientPointsOfSale).mockRejectedValue(new Error("SECRET_TOKEN SECRET_SIGN PRIVATE KEY stack"));
    const res = await POST(req(), context()); expect(res.status).toBe(500); expect(await res.text()).not.toMatch(/SECRET|PRIVATE|stack/); expect(log).not.toHaveBeenCalled();
  } finally { log.mockRestore(); }
});
it("returns safe machine diagnostics instead of blaming authorization", async () => {
  const failure = new PointsOfSaleError("upstream");
  Object.assign(failure, { diagnostic: { stage: "wsfe", category: "provider-errors", providerCodes: [602, "SECRET", -1, 1.2], httpStatus: "SECRET", raw: "PRIVATE" } });
  vi.mocked(checkClientPointsOfSale).mockRejectedValue(failure);
  const res = await POST(req(), context()); const data = await res.json();
  expect(data).toMatchObject({ code: "upstream", diagnostic: { stage: "wsfe", category: "provider-errors", providerCodes: [602] } });
  expect(JSON.stringify(data)).not.toMatch(/SECRET|PRIVATE|autorizaci/);
  expect(data.correlationId).toMatch(/^[a-f0-9-]{36}$/);
});
