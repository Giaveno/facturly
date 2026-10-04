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
  PayerCuitInvalidError,
  RowNotFoundError,
  RowNotResolvableError,
  resolvePayerCuit,
} from "@/lib/review/resolve-payer";

function errorJson(status: number, message: string, correlationId: string) {
  return NextResponse.json({ error: message, correlationId }, { status });
}

/**
 * POST /api/rows/[id]/resolve-payer — unblocks a flagged row by recording the
 * payer's CUIT (Mod-11 validated). The global payer registry LEARNS the CUIT
 * (via `upsertPayer`), the row is marked CORRECTED (invoice → REVIEWED), and the
 * resolution is audited. Body: `{ cuit: string }`.
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
    return errorJson(400, "Invalid row id", correlationId);
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
    const body = (await req.json()) as { cuit?: unknown };
    const cuit = typeof body.cuit === "string" ? body.cuit.replace(/[^0-9]/g, "") : "";
    const result = await resolvePayerCuit(getDb(), id, cuit);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof PayerCuitInvalidError) {
      return errorJson(400, "Invalid CUIT", correlationId);
    }
    if (err instanceof RowNotFoundError) {
      return errorJson(404, "Row not found", correlationId);
    }
    if (err instanceof RowNotResolvableError) {
      return errorJson(409, "This row cannot have a payer CUIT resolved", correlationId);
    }
    console.error(`[resolve-payer] ${correlationId} failed`, err);
    return errorJson(500, "Failed to resolve payer CUIT", correlationId);
  }
}
