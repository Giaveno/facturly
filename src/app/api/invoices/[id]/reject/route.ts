import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import {
  DiscardReasonError,
  InvoiceStateError,
  rejectInvoice,
} from "@/lib/review/workflow";
import { isUuid } from "@/lib/upload/guard";
import {
  isUnauthorizedError,
  requireAccountantSession,
} from "@/lib/auth/session";
import {
  assertSameOrigin,
  isForbiddenOriginError,
} from "@/lib/auth/origin";

function errorJson(status: number, message: string, correlationId: string) {
  return NextResponse.json({ error: message, correlationId }, { status });
}

/**
 * POST /api/invoices/[id]/reject — non-sale discard (PENDING/REVIEWED → REJECTED).
 *
 * Body: { "reason": string } (required). The row is soft-retained and can never
 * be emitted.
 *
 * Enforcement order: W5 (valid UUID) → C6 (auth seam, fail-closed) → reject.
 * Errors return an opaque message + correlation id (W4 — never raw internals).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const correlationId = randomUUID();

  // W5: validate the id BEFORE any DB work — a malformed UUID is a 400, not a
  // DB round-trip.
  if (!isUuid(id)) {
    return errorJson(400, "Invalid invoice id", correlationId);
  }

  // W2: same-origin (CSRF) check.
  try {
    assertSameOrigin(req);
  } catch (err) {
    if (isForbiddenOriginError(err)) {
      return errorJson(403, "Cross-origin request rejected", correlationId);
    }
    throw err;
  }

  // C6: the single centralized enforcement point — fail-closed: denies unless
  // the REAL NextAuth session has a user.
  try {
    await requireAccountantSession();
  } catch (err) {
    if (isUnauthorizedError(err)) {
      return errorJson(401, "Authentication required", correlationId);
    }
    throw err;
  }

  let reason = "";
  try {
    const body = (await req.json()) as { reason?: unknown };
    reason = typeof body.reason === "string" ? body.reason : "";
  } catch {
    // no body → reason stays ""
  }

  try {
    const result = await rejectInvoice(getDb(), id, reason);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof DiscardReasonError) {
      return errorJson(400, "A valid discard reason is required", correlationId);
    }
    if (err instanceof InvoiceStateError) {
      return errorJson(409, "This invoice cannot be discarded", correlationId);
    }
    console.error(`[reject] ${correlationId} failed`, err);
    return errorJson(500, "Rejection failed", correlationId);
  }
}
