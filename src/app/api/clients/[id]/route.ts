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
  ClientValidationError,
  updateClient,
} from "@/lib/clients/clients";

function errorJson(status: number, message: string, correlationId: string) {
  return NextResponse.json({ error: message, correlationId }, { status });
}

/**
 * PATCH /api/clients/[id] — edits a client's razonSocial/CUIT/ptoVta/condicionIva.
 *
 * Enforcement order: valid UUID → same-origin → auth seam → validation/DB.
 */
export async function PATCH(
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

  try {
    const body = (await req.json()) as unknown;
    const updated = await updateClient(getDb(), id, body);
    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof ClientValidationError) {
      return errorJson(400, "Invalid client data", correlationId);
    }
    if (err instanceof ClientNotFoundError) {
      return errorJson(404, "Client not found", correlationId);
    }
    console.error(`[clients] ${correlationId} update failed`, err);
    return errorJson(500, "Failed to update client", correlationId);
  }
}
