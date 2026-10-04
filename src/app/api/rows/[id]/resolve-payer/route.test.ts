import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/session")>();
  return { ...actual, requireAccountantSession: vi.fn() };
});
vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/review/resolve-payer", () => ({
  PayerCuitInvalidError: class PayerCuitInvalidError extends Error {},
  RowNotFoundError: class RowNotFoundError extends Error {},
  RowNotResolvableError: class RowNotResolvableError extends Error {},
  resolvePayerCuit: vi.fn(),
}));

import {
  requireAccountantSession,
  UnauthorizedError,
} from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import {
  PayerCuitInvalidError,
  RowNotFoundError,
  RowNotResolvableError,
  resolvePayerCuit,
} from "@/lib/review/resolve-payer";
import { POST as resolvePOST } from "@/app/api/rows/[id]/resolve-payer/route";

const VALID_UUID = "00000000-0000-4000-8000-000000000000";

function req(body?: unknown, init?: { origin?: string }): Request {
  const headers = new Headers();
  headers.set("host", "app.example.com");
  if (init?.origin) headers.set("origin", init.origin);
  return new Request("http://app.example.com/api/rows", {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
  });
}

describe("resolve-payer route — auth, same-origin, CUIT validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAccountantSession).mockImplementation(async () => {
      throw new UnauthorizedError();
    });
  });

  it("rejects a non-UUID [id] with 400 before auth or DB", async () => {
    const res = await resolvePOST(req({ cuit: "30710145764" }), { params: Promise.resolve({ id: "nope" }) });
    expect(res.status).toBe(400);
    expect(requireAccountantSession).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin request with 403 BEFORE auth", async () => {
    vi.mocked(requireAccountantSession).mockImplementation(async () => {});
    const res = await resolvePOST(req({ cuit: "30710145764" }, { origin: "https://evil.net" }), { params: Promise.resolve({ id: VALID_UUID }) });
    expect(res.status).toBe(403);
    expect(requireAccountantSession).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated with 401", async () => {
    const res = await resolvePOST(req({ cuit: "30710145764" }), { params: Promise.resolve({ id: VALID_UUID }) });
    expect(res.status).toBe(401);
    expect(resolvePayerCuit).not.toHaveBeenCalled();
  });

  it("maps an invalid CUIT to an opaque 400", async () => {
    vi.mocked(requireAccountantSession).mockImplementation(async () => {});
    vi.mocked(resolvePayerCuit).mockRejectedValue(new PayerCuitInvalidError("bad"));
    const res = await resolvePOST(req({ cuit: "bad" }), { params: Promise.resolve({ id: VALID_UUID }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("bad");
  });

  it("maps a missing row to 404", async () => {
    vi.mocked(requireAccountantSession).mockImplementation(async () => {});
    vi.mocked(resolvePayerCuit).mockRejectedValue(new RowNotFoundError(VALID_UUID));
    const res = await resolvePOST(req({ cuit: "30710145764" }), { params: Promise.resolve({ id: VALID_UUID }) });
    expect(res.status).toBe(404);
  });

  it("maps a non-resolvable row (FAILED / terminal invoice) to 409", async () => {
    vi.mocked(requireAccountantSession).mockImplementation(async () => {});
    vi.mocked(resolvePayerCuit).mockRejectedValue(new RowNotResolvableError("FAILED"));
    const res = await resolvePOST(req({ cuit: "30710145764" }), { params: Promise.resolve({ id: VALID_UUID }) });
    expect(res.status).toBe(409);
  });

  it("strips CUIT separators and returns the materialized invoice state on success", async () => {
    vi.mocked(requireAccountantSession).mockImplementation(async () => {});
    vi.mocked(getDb).mockReturnValue({} as never);
    vi.mocked(resolvePayerCuit).mockResolvedValue({
      rowId: VALID_UUID,
      status: "CORRECTED",
      invoiceId: VALID_UUID,
      invoiceStatus: "REVIEWED",
      learnedFrom: "manual",
      inserted: true,
    });

    const res = await resolvePOST(req({ cuit: "30-71014576-4" }), { params: Promise.resolve({ id: VALID_UUID }) });
    expect(res.status).toBe(200);
    // The separators are stripped before the service call.
    expect(resolvePayerCuit).toHaveBeenCalledWith({}, VALID_UUID, "30710145764");
  });
});
