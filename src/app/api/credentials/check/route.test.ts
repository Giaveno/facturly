import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/auth/session", async original => ({ ...await original<typeof import("@/lib/auth/session")>(), requireAccountantSession: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/lib/credentials/connection-check", async original => ({ ...await original<typeof import("@/lib/credentials/connection-check")>(), checkCredentialConnection: vi.fn() }));
import { requireAccountantSession, UnauthorizedError } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { checkCredentialConnection, ConnectionCheckError } from "@/lib/credentials/connection-check";
import { POST } from "./route";
const fingerprint = "a".repeat(64);
const req = (origin = "https://app.example.com", body: unknown = { fingerprint }) => new Request("https://app.example.com/api/credentials/check", { method: "POST", headers: { host: "app.example.com", origin }, body: JSON.stringify(body) });
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("ARCA_ENV", "homologacion"); vi.mocked(requireAccountantSession).mockResolvedValue(); });
afterEach(() => vi.unstubAllEnvs());
it("rejects cross-origin and missing-origin before auth or DB", async () => {
  for (const origin of ["https://evil.example.com", ""]) expect((await POST(req(origin))).status).toBe(403);
  expect(requireAccountantSession).not.toHaveBeenCalled(); expect(getDb).not.toHaveBeenCalled(); expect(checkCredentialConnection).not.toHaveBeenCalled();
});
it("requires authenticated accountant before database or check", async () => {
  vi.mocked(requireAccountantSession).mockRejectedValue(new UnauthorizedError()); expect((await POST(req())).status).toBe(401);
  expect(getDb).not.toHaveBeenCalled(); expect(checkCredentialConnection).not.toHaveBeenCalled();
});
it.each(["production", "oops", ""])("refuses %s before database/check", async env => {
  vi.stubEnv("ARCA_ENV", env); expect((await POST(req())).status).toBe(409); expect(getDb).not.toHaveBeenCalled(); expect(checkCredentialConnection).not.toHaveBeenCalled();
});
it("accepts only the expected public fingerprint, never client-selected URLs, services or key", async () => {
  for (const body of [{}, { fingerprint: "bad" }, { fingerprint, url: "https://evil" }, { fingerprint, service: "wsfe" }, { fingerprint, keyPem: "SECRET" }]) expect((await POST(req(undefined, body))).status).toBe(400);
  expect(checkCredentialConnection).not.toHaveBeenCalled();
});
it("returns sanitized public service statuses without caching", async () => {
  const report = { environment: "homologacion" as const, certificate: null, services: [{ service: "wsfe" as const, status: "not_configured" as const }] };
  vi.mocked(checkCredentialConnection).mockResolvedValue(report);
  const res = await POST(req()); expect(res.status).toBe(200); expect(await res.json()).toEqual(report); expect(res.headers.get("cache-control")).toContain("no-store");
  expect(checkCredentialConnection).toHaveBeenCalledWith({}, process.env, fingerprint);
});
it("maps changed certificate and total timeout safely; never logs raw failures", async () => {
  for (const [code, status] of [["changed", 409], ["timeout", 504]] as const) {
    vi.mocked(checkCredentialConnection).mockRejectedValue(new ConnectionCheckError(code)); expect((await POST(req())).status).toBe(status);
  }
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    vi.mocked(checkCredentialConnection).mockRejectedValue(new Error("SECRET_TOKEN PRIVATE KEY stack"));
    const res = await POST(req()); expect(res.status).toBe(500); expect(await res.text()).not.toMatch(/SECRET|PRIVATE|stack/); expect(log).not.toHaveBeenCalled();
  } finally { log.mockRestore(); }
});
