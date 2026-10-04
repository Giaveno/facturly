import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/session")>();
  return { ...actual, requireAccountantSession: vi.fn() };
});
vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/clients/clients", () => ({
  ClientValidationError: class ClientValidationError extends Error {},
  ClientNotFoundError: class ClientNotFoundError extends Error {},
  createClient: vi.fn(),
  listClients: vi.fn(),
  updateClient: vi.fn(),
  setDelegationEnabled: vi.fn(),
}));

import {
  requireAccountantSession,
  UnauthorizedError,
} from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import {
  ClientValidationError,
  ClientNotFoundError,
  createClient,
  listClients,
  updateClient,
  setDelegationEnabled,
} from "@/lib/clients/clients";
import { GET as clientsGET, POST as clientsPOST } from "@/app/api/clients/route";
import { PATCH as clientsPATCH } from "@/app/api/clients/[id]/route";
import { POST as delegationPOST } from "@/app/api/clients/[id]/delegation/route";

const VALID_UUID = "00000000-0000-4000-8000-000000000000";

function req(body?: unknown, init?: { origin?: string }): Request {
  const headers = new Headers();
  headers.set("host", "app.example.com");
  if (init?.origin) headers.set("origin", init.origin);
  return new Request("http://app.example.com/api/clients", {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("clients routes — auth, same-origin, validation, opaque errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAccountantSession).mockImplementation(async () => {
      throw new UnauthorizedError();
    });
  });

  it("GET list rejects unauthenticated with 401", async () => {
    const res = await clientsGET();
    expect(res.status).toBe(401);
    expect(listClients).not.toHaveBeenCalled();
  });

  it("POST create rejects a cross-origin request with 403 BEFORE auth", async () => {
    vi.mocked(requireAccountantSession).mockImplementation(async () => {});
    const res = await clientsPOST(req({ razonSocial: "X" }, { origin: "https://evil.net" }));
    expect(res.status).toBe(403);
    expect(requireAccountantSession).not.toHaveBeenCalled();
  });

  it("POST create rejects unauthenticated with 401", async () => {
    const res = await clientsPOST(req({ razonSocial: "X" }));
    expect(res.status).toBe(401);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("POST create maps invalid client data to an opaque 400", async () => {
    vi.mocked(requireAccountantSession).mockImplementation(async () => {});
    vi.mocked(createClient).mockRejectedValue(new ClientValidationError("cuit is not a valid CUIT"));
    const res = await clientsPOST(req({ cuit: "bad" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("cuit");
  });

  it("POST create maps a duplicate CUIT (23505) to 409", async () => {
    vi.mocked(requireAccountantSession).mockImplementation(async () => {});
    vi.mocked(createClient).mockRejectedValue(Object.assign(new Error("dup"), { code: "23505" }));
    const res = await clientsPOST(req({ razonSocial: "X" }));
    expect(res.status).toBe(409);
  });

  it("POST create returns 201 on success", async () => {
    vi.mocked(requireAccountantSession).mockImplementation(async () => {});
    vi.mocked(getDb).mockReturnValue({} as never);
    vi.mocked(createClient).mockResolvedValue({
      client: { id: VALID_UUID, cuit: "30710145764", razonSocial: "X S.A.", ptoVta: 1, condicionIva: "ri" },
      delegation: true,
    } as never);
    const res = await clientsPOST(req({ razonSocial: "X S.A.", cuit: "30710145764", ptoVta: 1, condicionIva: "ri" }));
    expect(res.status).toBe(201);
  });

  it("PATCH rejects a non-UUID [id] with 400 before auth or DB", async () => {
    const res = await clientsPATCH(req({ razonSocial: "X" }), params("nope"));
    expect(res.status).toBe(400);
    expect(requireAccountantSession).not.toHaveBeenCalled();
  });

  it("PATCH maps a missing client to 404", async () => {
    vi.mocked(requireAccountantSession).mockImplementation(async () => {});
    vi.mocked(updateClient).mockRejectedValue(new ClientNotFoundError(VALID_UUID));
    const res = await clientsPATCH(req({ razonSocial: "X" }), params(VALID_UUID));
    expect(res.status).toBe(404);
  });

  it("delegation POST rejects a non-UUID [id] with 400", async () => {
    const res = await delegationPOST(req({ enabled: false }), params("nope"));
    expect(res.status).toBe(400);
    expect(setDelegationEnabled).not.toHaveBeenCalled();
  });

  it("delegation POST maps a missing client to 404", async () => {
    vi.mocked(requireAccountantSession).mockImplementation(async () => {});
    vi.mocked(setDelegationEnabled).mockRejectedValue(new ClientNotFoundError(VALID_UUID));
    const res = await delegationPOST(req({ enabled: false }), params(VALID_UUID));
    expect(res.status).toBe(404);
  });
});
