import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth/session", () => ({ requireAccountantSession: vi.fn(), isUnauthorizedError: (e: unknown) => e instanceof Error && e.message === "unauthorized" }));
vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/emission/gateway", () => ({ buildArcaGateway: vi.fn(() => ({})) }));
vi.mock("@/lib/emission/comprobante-emission-service", () => ({ verifyComprobante: vi.fn(), ComprobanteEmissionError: class ComprobanteEmissionError extends Error {} }));
import { requireAccountantSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { verifyComprobante, ComprobanteEmissionError } from "@/lib/emission/comprobante-emission-service";
import { POST } from "./route";
const id = "00000000-0000-4000-8000-000000000001";
const empresaId = "00000000-0000-4000-8000-000000000002";
const request = (headers = {}) => new Request(`http://app.test/api/comprobantes/${id}/verify`, { method: "POST", headers: { host: "app.test", "x-empresa-id": empresaId, ...headers } });
const context = { params: Promise.resolve({ id }) };
const db = (rows: unknown[]) => ({ select: () => ({ from: () => ({ where: async () => rows }) }) });
describe("read-only comprobante verification route", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(requireAccountantSession).mockResolvedValue(undefined); vi.mocked(getDb).mockReturnValue(db([{ id }]) as never); });
  it("rejects unauthenticated and cross-origin calls before accessing ARCA", async () => {
    vi.mocked(requireAccountantSession).mockRejectedValue(new Error("unauthorized"));
    expect((await POST(request(), context)).status).toBe(401);
    expect((await POST(request({ origin: "https://other.test" }), context)).status).toBe(403);
    expect(verifyComprobante).not.toHaveBeenCalled();
  });
  it("rejects invalid IDs and rows outside the company scope", async () => {
    expect((await POST(request(), { params: Promise.resolve({ id: "bad" }) })).status).toBe(400);
    vi.mocked(getDb).mockReturnValue(db([]) as never);
    expect((await POST(request(), context)).status).toBe(404);
    expect(verifyComprobante).not.toHaveBeenCalled();
  });
  it.each(["aprobado", "rechazado"])("returns persisted %s after exactly one targeted verification", async estado => {
    vi.mocked(verifyComprobante).mockResolvedValue({ id, empresaId, estado } as never);
    const response = await POST(request(), context);
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ id, estado });
    expect(verifyComprobante).toHaveBeenCalledTimes(1);
    expect(verifyComprobante).toHaveBeenCalledWith(expect.anything(), id, empresaId);
  });
  it("preserves the grace error and never exposes raw database errors", async () => {
    vi.mocked(verifyComprobante).mockRejectedValue(new ComprobanteEmissionError("Período de seguridad pendiente"));
    expect((await POST(request(), context)).status).toBe(409);
    vi.mocked(getDb).mockImplementation(() => { throw new Error("SQL PASSWORD=secret"); });
    const response = await POST(request(), context);
    expect(response.status).toBe(502); expect(JSON.stringify(await response.json())).not.toContain("secret");
  });
});
