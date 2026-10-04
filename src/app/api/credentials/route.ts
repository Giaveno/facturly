import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import {
  isUnauthorizedError,
  requireAccountantSession,
} from "@/lib/auth/session";
import {
  assertSameOrigin,
  isForbiddenOriginError,
} from "@/lib/auth/origin";
import { InvalidPemError, KeyMismatchError } from "@/lib/credentials/pem";
import { saveCredentials } from "@/lib/credentials/service";

function errorJson(status: number, message: string, correlationId: string) {
  return NextResponse.json({ error: message, correlationId }, { status });
}

/**
 * POST /api/credentials — the "plug in ARCA" step. Uploads the accountant's
 * X.509 certificate (PEM) + private key (PEM), validates the pair, encrypts the
 * private key at rest (AES-256-GCM, AES_KEY), and returns ONLY public metadata
 * (subject CN, CUIT, validity window). The plaintext key is never logged,
 * echoed, or returned.
 *
 * Body: `{ certPem: string, keyPem: string }`.
 *
 * Enforcement order: same-origin → auth seam → parse/validate → encrypt/persist.
 */
export async function POST(req: Request): Promise<Response> {
  const correlationId = randomUUID();

  try {
    assertSameOrigin(req);
  } catch (err) {
    if (isForbiddenOriginError(err)) {
      return errorJson(403, "Cross-origin request rejected", correlationId);
    }
    throw err;
  }

  try {
    await requireAccountantSession();
  } catch (err) {
    if (isUnauthorizedError(err)) {
      return errorJson(401, "Authentication required", correlationId);
    }
    throw err;
  }

  try {
    const body = (await req.json()) as { certPem?: unknown; keyPem?: unknown };
    const certPem = typeof body.certPem === "string" ? body.certPem : "";
    const keyPem = typeof body.keyPem === "string" ? body.keyPem : "";

    if (certPem.trim() === "" || keyPem.trim() === "") {
      return errorJson(400, "Both the certificate and private key are required", correlationId);
    }

    const aesKey = process.env.AES_KEY ?? "";
    const info = await saveCredentials(getDb(), { certPem, keyPem }, aesKey);
    // PUBLIC metadata only — never the key.
    return NextResponse.json(info);
  } catch (err) {
    if (err instanceof InvalidPemError) {
      return errorJson(400, "The certificate or private key is invalid", correlationId);
    }
    if (err instanceof KeyMismatchError) {
      return errorJson(400, "The private key does not match the certificate", correlationId);
    }
    console.error(`[credentials] ${correlationId} failed`, err);
    return errorJson(500, "Failed to save credentials", correlationId);
  }
}
