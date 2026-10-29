import { beforeEach, describe, expect, it, vi } from "vitest";

// Thin route over the tested `saveCredentials` service. We mock the auth seam,
// the DB, and the service; the same-origin (CSRF) check and the PEM error
// classes run for real, so the route-level security behaviours are proven.
vi.mock("@/lib/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/session")>();
  return { ...actual, requireAccountantSession: vi.fn() };
});
vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/credentials/service", () => ({ saveCredentials: vi.fn() }));

import {
  requireAccountantSession,
  UnauthorizedError,
} from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { saveCredentials } from "@/lib/credentials/service";
import { InvalidPemError, KeyMismatchError } from "@/lib/credentials/pem";
import { POST as credentialsPOST } from "@/app/api/credentials/route";

function req(body?: unknown, init?: { origin?: string }): Request {
  const headers = new Headers();
  headers.set("host", "app.example.com");
  if (init?.origin) headers.set("origin", init.origin);
  return new Request("http://app.example.com/api/credentials", {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
  });
}

describe("credentials route — security + pair validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAccountantSession).mockImplementation(async () => {
      throw new UnauthorizedError();
    });
  });

  it("rejects an unauthenticated upload with 401 (no DB, no service)", async () => {
    const res = await credentialsPOST(req({ certPem: "c", keyPem: "k" }));
    expect(res.status).toBe(401);
    expect(getDb).not.toHaveBeenCalled();
    expect(saveCredentials).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin upload with 403 BEFORE auth", async () => {
    vi.mocked(requireAccountantSession).mockImplementation(async () => {});
    const res = await credentialsPOST(
      req({ certPem: "c", keyPem: "k" }, { origin: "https://evil.example.net" }),
    );
    expect(res.status).toBe(403);
    expect(requireAccountantSession).not.toHaveBeenCalled();
  });

  it("rejects an empty cert/key pair with 400", async () => {
    vi.mocked(requireAccountantSession).mockImplementation(async () => {});
    const res = await credentialsPOST(req({ certPem: "  ", keyPem: "" }));
    expect(res.status).toBe(400);
    expect(saveCredentials).not.toHaveBeenCalled();
  });

  it("maps an invalid PEM to an opaque 400", async () => {
    vi.mocked(requireAccountantSession).mockImplementation(async () => {});
    vi.mocked(saveCredentials).mockRejectedValue(new InvalidPemError("certificate"));
    const res = await credentialsPOST(req({ certPem: "bad", keyPem: "bad" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    // The raw InvalidPemError detail ("unparseable") must NOT leak.
    expect(JSON.stringify(body)).not.toContain("unparseable");
  });

  it("maps a key/cert mismatch to an opaque 400", async () => {
    vi.mocked(requireAccountantSession).mockImplementation(async () => {});
    vi.mocked(saveCredentials).mockRejectedValue(new KeyMismatchError());
    const res = await credentialsPOST(req({ certPem: "c", keyPem: "k" }));
    expect(res.status).toBe(400);
  });

  it("returns ONLY public metadata on success (never the key)", async () => {
    vi.mocked(requireAccountantSession).mockImplementation(async () => {});
    vi.mocked(getDb).mockReturnValue({} as never);
    vi.mocked(saveCredentials).mockResolvedValue({
      fingerprint: "a".repeat(64),
      subjectCn: "ESTUDIO S.A.",
      cuit: "30710145764",
      notBefore: "Oct  4 00:00:00 2026 GMT",
      notAfter: "Oct  4 00:00:00 2027 GMT",
    });

    const res = await credentialsPOST(req({ certPem: "CERT", keyPem: "SECRETKEY" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.subjectCn).toBe("ESTUDIO S.A.");
    expect(JSON.stringify(body)).not.toContain("SECRETKEY");
  });

  it("returns an opaque 500 for an unexpected failure (never leaks AES_KEY errors)", async () => {
    vi.mocked(requireAccountantSession).mockImplementation(async () => {});
    vi.mocked(getDb).mockReturnValue({} as never);
    vi.mocked(saveCredentials).mockRejectedValue(new Error("AES_KEY must decode to 32 bytes"));

    const res = await credentialsPOST(req({ certPem: "c", keyPem: "k" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("AES_KEY");
  });

  it("never logs the private key, even on an unexpected failure (W5)", async () => {
    vi.mocked(requireAccountantSession).mockImplementation(async () => {});
    vi.mocked(getDb).mockReturnValue({} as never);
    vi.mocked(saveCredentials).mockRejectedValue(new Error("PRIVATE KEY SECRETKEYMATERIAL raw remote payload"));

    const KEY = "-----BEGIN PRIVATE KEY-----\nSECRETKEYMATERIAL\n-----END PRIVATE KEY-----";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await credentialsPOST(req({ certPem: "CERT", keyPem: KEY }));
      expect(res.status).toBe(500);

      const logged = spy.mock.calls
        .map((args) => args.map(String).join(" "))
        .join("\n");
      expect(logged).not.toContain(KEY);
      expect(logged).not.toContain("BEGIN PRIVATE KEY");
      expect(logged).not.toContain("SECRETKEYMATERIAL");
      expect(logged).not.toContain("raw remote payload");
    } finally {
      spy.mockRestore();
    }
  });
});
