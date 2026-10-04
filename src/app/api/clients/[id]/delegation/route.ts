import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { isUuid } from "@/lib/upload/guard";
import {
  isUnauthorizedError,
  requireAccountantSession,
} from "@/lib/auth/session";
import {
  assertSameOrigin,
  isForbiddenOriginError,
} from "@/lib/auth/origin";
import {
  ClientNotFoundError,
  setDelegationEnabled,
} from "@/lib/clients/clients";

function errorJson(status: number, message: string, correlationId: string) {
  return NextResponse.json({ error: message, correlationId }, { status });
}

/**
 * POST /api/clients/[id]/delegation — enables/disables a client's `wsfe`
 * delegation. Body: `{ enabled: boolean }`.
 *
 * A client with no enabled delegation cannot be emitted for (the emission
 * service already fails closed); this route is the accountant's control for it.
 *
 * Enforcement order: valid UUID → same-origin → auth seam → validation/DB.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const correlationId = randomUUID();

  if (!isUuid(id)) {
    return errorJson(400, "Invalid client id", correlationId);
  }

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

  let enabled = true;
  try {
    const body = (await req.json()) as { enabled?: unknown };
    enabled = typeof body.enabled === "boolean" ? body.enabled : true;
  } catch {
    // no body → default to enabling (explicit is better, but never crash)
  }

  try {
    const result = await setDelegationEnabled(getDb(), id, enabled);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ClientNotFoundError) {
      return errorJson(404, "Client not found", correlationId);
    }
    console.error(`[clients] ${correlationId} delegation failed`, err);
    return errorJson(500, "Failed to update delegation", correlationId);
  }
}
