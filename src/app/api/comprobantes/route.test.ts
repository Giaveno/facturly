import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ requireAccountantSession: vi.fn(), isUnauthorizedError: (e: unknown) => e instanceof Error && e.message === "unauthorized" }));
vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/db/schema", () => ({ comprobantes: { empresaId: "empresaId", id: "id", estado: "estado", cbteTipo: "cbteTipo", cbteNro: "cbteNro", cae: "cae", caeVto: "caeVto", errores: "errores", ambiente: "ambiente", createdAt: "createdAt" } }));
vi.mock("@/lib/emission/gateway", () => ({ buildArcaGateway: vi.fn() }));
vi.mock("@/lib/emission/comprobante-emission-service", () => ({ emitComprobante: vi.fn(), ComprobanteEmissionError: class ComprobanteEmissionError extends Error {}, SERIES_BLOCKED_MESSAGE: "serie bloqueada, pendiente de conciliación", RECONCILIATION_UNCERTAIN_REASON: "incertain" }));

import { GET, POST } from "@/app/api/comprobantes/route";
import { requireAccountantSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { emitComprobante } from "@/lib/emission/comprobante-emission-service";

const request = (body: unknown, headers: Record<string, string> = {}) => new Request("http://app.example.com/api/comprobantes", { method: "POST", body: JSON.stringify(body), headers: { host: "app.example.com", ...headers } });
const listingRequest = (url: string) => new Request(url, { headers: { host: "app.example.com" } });

describe("comprobantes route", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(requireAccountantSession).mockResolvedValue(undefined); });
  it("rejects unauthenticated reads", async () => { vi.mocked(requireAccountantSession).mockRejectedValue(new Error("unauthorized")); expect((await GET(listingRequest("http://app.example.com/api/comprobantes"))).status).toBe(401); });
  it("rejects an unscoped listing", async () => { expect((await GET(listingRequest("http://app.example.com/api/comprobantes"))).status).toBe(403); });
  it("requires an idempotency key", async () => { expect((await POST(request({ empresaId: "x" }))).status).toBe(400); });
  it("uses the header key and does not trust body ambiente", async () => {
    vi.mocked(emitComprobante).mockResolvedValue({ id: "x", empresaId: "e", estado: "aprobado", cbteNro: 1, cae: "1", caeVto: "2026-01-01", resultado: "A", errores: null, emitted: true });
    const response = await POST(request({ empresaId: "e", ambiente: "production" }, { "Idempotency-Key": "stable" }));
    expect(response.status).toBe(200);
    expect(vi.mocked(emitComprobante).mock.calls[0]?.[1]).toMatchObject({ idempotencyKey: "stable", empresaId: "e" });
    expect(vi.mocked(emitComprobante).mock.calls[0]?.[0].environment).toBeUndefined();
  });
  it("returns blocked series as an explicit non-retryable outcome", async () => { vi.mocked(emitComprobante).mockRejectedValue(new Error("serie bloqueada, pendiente de conciliación")); const response = await POST(request({ empresaId: "e", idempotencyKey: "stable" })); const body = await response.json(); expect(response.status).toBe(409); expect(body.code).toBe("SERIES_BLOCKED"); expect(body.status).toBe("incierto"); });
});

