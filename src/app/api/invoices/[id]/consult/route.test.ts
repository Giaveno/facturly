import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth/session", () => ({ requireAccountantSession: vi.fn(), isUnauthorizedError: (e: unknown) => e instanceof Error && e.message === "unauthorized" }));
vi.mock("@/lib/db/client", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/lib/invoices/reconciliation", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/invoices/reconciliation")>(), consultReservedInvoice: vi.fn() }));
import { requireAccountantSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { consultReservedInvoice } from "@/lib/invoices/reconciliation";
import { POST } from "./route";
const id = "00000000-0000-4000-8000-000000000001";
const request = (origin: string | null = "http://localhost", body = "{}") => new Request(`http://localhost/api/invoices/${id}/consult`, { method: "POST", headers: { ...(origin ? { origin } : {}), "content-type": "application/json" }, body });
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("ARCA_ENV", "homologacion"); vi.stubEnv("APP_ORIGIN", "http://localhost"); vi.mocked(requireAccountantSession).mockResolvedValue({} as never); });
describe("invoice read-only consultation route", () => {
    it.each([null, "https://evil.test"])("rejects origin %s before DB", async (origin) => { expect((await POST(request(origin), { params: Promise.resolve({ id }) })).status).toBe(403); expect(getDb).not.toHaveBeenCalled(); });
    it("rejects invalid UUID", async () => { expect((await POST(request(), { params: Promise.resolve({ id: "bad" }) })).status).toBe(400); expect(getDb).not.toHaveBeenCalled(); });
    it("requires a session", async () => { vi.mocked(requireAccountantSession).mockRejectedValue(new Error("unauthorized")); expect((await POST(request(), { params: Promise.resolve({ id }) })).status).toBe(401); expect(getDb).not.toHaveBeenCalled(); });
    it("checks homologation before DB", async () => { vi.stubEnv("ARCA_ENV", "production"); expect((await POST(request(), { params: Promise.resolve({ id }) })).status).toBe(409); expect(getDb).not.toHaveBeenCalled(); });
    it.each(['{"cuit":"30710145764"}', '{"cbteNro":8}', '{"url":"https://evil.test"}', 'null'])("rejects caller fiscal override %s", async (body) => { expect((await POST(request("http://localhost", body), { params: Promise.resolve({ id }) })).status).toBe(400); expect(getDb).not.toHaveBeenCalled(); });
    it("passes only ID and returns no-store", async () => { vi.mocked(consultReservedInvoice).mockResolvedValue({ status: "matched" } as never); const r = await POST(request(), { params: Promise.resolve({ id }) }); expect(r.status).toBe(200); expect(r.headers.get("cache-control")).toBe("no-store"); expect(consultReservedInvoice).toHaveBeenCalledWith(expect.anything(), process.env, id); });
});
