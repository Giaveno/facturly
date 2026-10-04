import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { InvoiceStateError, markInvoiceReviewed } from "@/lib/review/workflow";
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
 * POST /api/invoices/[id]/review — the accountant confirms the extraction is
 * correct (PENDING → REVIEWED). This is the existing `markInvoiceReviewed`
 * transition, wired so a confident row can reach the APPROVED state (the
 * approve route only accepts REVIEWED invoices).
 *
 * Enforcement order: valid UUID → same-origin → auth seam → transition.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const correlationId = randomUUID();

  if (!isUuid(id)) {
    return errorJson(400, "Invalid invoice id", correlationId);
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
    const result = await markInvoiceReviewed(getDb(), id);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof InvoiceStateError) {
      return errorJson(409, "Invoice is not in a reviewable state", correlationId);
    }
    console.error(`[review] ${correlationId} failed`, err);
    return errorJson(500, "Failed to mark invoice reviewed", correlationId);
  }
}
