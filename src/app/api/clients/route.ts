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
import {
  ClientValidationError,
  createClient,
  listClients,
} from "@/lib/clients/clients";
import { isUniqueViolation } from "@/lib/db/errors";

function errorJson(status: number, message: string, correlationId: string) {
  return NextResponse.json({ error: message, correlationId }, { status });
}

/**
 * GET /api/clients — lists the accountant's client companies + delegation state.
 *
 * Read-only, so it enforces the auth seam (fail-closed) but not the same-origin
 * check (CSRF is a browser state-change attack).
 */
export async function GET(): Promise<Response> {
  const correlationId = randomUUID();
  try {
    await requireAccountantSession();
  } catch (err) {
    if (isUnauthorizedError(err)) {
      return errorJson(401, "Authentication required", correlationId);
    }
    throw err;
  }
  try {
    return NextResponse.json(await listClients(getDb()));
  } catch (err) {
    console.error(`[clients] ${correlationId} list failed`, err);
    return errorJson(500, "Failed to list clients", correlationId);
  }
}

/**
 * POST /api/clients — creates a client (validated CUIT, emisor IVA condition)
 * and, by default, its `wsfe` delegation. Body: `{ razonSocial, cuit, ptoVta,
 * condicionIva, createDelegation? }`.
 *
 * Enforcement order: same-origin → auth seam → validation/DB. Errors are opaque
 * (never raw DB detail) with a correlation id.
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
    const body = (await req.json()) as unknown;
    const result = await createClient(getDb(), body);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof ClientValidationError) {
      return errorJson(400, "Invalid client data", correlationId);
    }
    if (isUniqueViolation(err)) {
      return errorJson(409, "A client with this CUIT already exists", correlationId);
    }
    console.error(`[clients] ${correlationId} create failed`, err);
    return errorJson(500, "Failed to create client", correlationId);
  }
}
