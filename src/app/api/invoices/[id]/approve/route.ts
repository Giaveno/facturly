import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { approveInvoice, InvoiceStateError } from "@/lib/review/workflow";
import { buildArcaGateway } from "@/lib/emission/gateway";
import { isUuid } from "@/lib/upload/guard";
import {
  isUnauthorizedError,
  requireAccountantSession,
} from "@/lib/auth/session";
import {
  assertSameOrigin,
  isForbiddenOriginError,
} from "@/lib/auth/origin";
import { parseApprovalSnapshot } from "@/domain/approval-snapshot";
import { resolveArcaEnvironment } from "@/lib/emission/environment";
import { inngest } from "@/lib/inngest/client";
import { EmissionConfigurationError } from "@/adapters/arca/emissions";

function errorJson(status: number, message: string, correlationId: string) {
  return NextResponse.json({ error: message, correlationId }, { status });
}

/**
 * POST /api/invoices/[id]/approve — server-side approval (REVIEWED → APPROVED).
 *
 * The review UI's disabled button is a hint; THIS is the enforcement. It
 * resolves the comprobante type + receptor via the gateway (Padrón A5) and only
 * ever approves a REVIEWED invoice (never a BLOCKED/REJECTED one). On success it
 * triggers the (async) emission of the approved invoice (C4).
 *
 * Enforcement order: W5 (valid UUID) → C6 (auth seam, fail-closed) → approve.
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

  // W2: same-origin (CSRF) check — a browser request whose Origin is not this
  // app is rejected (approve triggers a REAL ARCA emission).
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

  let expected;
  try { const body = await req.json(); expected = parseApprovalSnapshot(body?.expected); }
  catch { return errorJson(400,"Se requiere confirmar los datos actuales del comprobante.",correlationId); }
  try {
    const db = getDb();
    const approved = await approveInvoice(db, buildArcaGateway(db), id, undefined, expected, resolveArcaEnvironment(process.env));
    // C4: trigger the (async) emission of the just-approved invoice. The
    // idempotencyKey = invoiceId so a duplicate event is deduped by Inngest.
    await inngest.send({
      name: "emit/batch.requested",
      data: { invoiceIds: [id], idempotencyKey: id },
    });
    return NextResponse.json({ id: approved.id, status: approved.status });
  } catch (err) {
    if (err instanceof EmissionConfigurationError) {
      return NextResponse.json({ error: err.publicMessage, correlationId, code: err.code, status: "deshabilitada" }, { status: err.status });
    }
    if (err instanceof InvoiceStateError) {
      return errorJson(409, err.publicMessage ?? "Invoice is not in an approvable state", correlationId);
    }
    console.error(`[approve] ${correlationId} failed`, err);
    return errorJson(500, "Approval failed", correlationId);
  }
}
