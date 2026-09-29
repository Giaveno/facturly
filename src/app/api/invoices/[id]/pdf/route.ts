import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { isUuid } from "@/lib/upload/guard";
import {
  isUnauthorizedError,
  requireAccountantSession,
} from "@/lib/auth/session";
import { loadIssuedInvoicePdfInput } from "@/lib/invoices/read-model";
import { buildInvoicePdfModel, renderInvoicePdf } from "@/pdf/render";

function errorJson(status: number, message: string, correlationId: string) {
  return NextResponse.json({ error: message, correlationId }, { status });
}

/**
 * GET /api/invoices/[id]/pdf — renders and serves the issued invoice's PDF.
 *
 * Enforcement order: W5 (valid UUID → 400) → auth seam (fail-closed → 401) →
 * issued-invoice check (no CAE → opaque 404) → render. A NULL-CAE reservation is
 * NOT an issued invoice and is refused. The response carries the correct
 * `Content-Type` (application/pdf) and a `Content-Disposition` filename.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const correlationId = randomUUID();

  // W5: validate the id BEFORE any DB work.
  if (!isUuid(id)) {
    return errorJson(400, "Invalid invoice id", correlationId);
  }

  // Auth seam — fail-closed: denies unless the real session has a user.
  try {
    await requireAccountantSession();
  } catch (err) {
    if (isUnauthorizedError(err)) {
      return errorJson(401, "Authentication required", correlationId);
    }
    throw err;
  }

  try {
    const input = await loadIssuedInvoicePdfInput(getDb(), id);
    if (!input) {
      // Opaque: do not reveal whether the id exists vs. is a NULL-CAE
      // reservation.
      return errorJson(404, "Invoice not found or not issued", correlationId);
    }
    const model = buildInvoicePdfModel(input);
    const pdf = await renderInvoicePdf(model);
    return new NextResponse(Buffer.from(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="invoice-${input.cbteNro}.pdf"`,
      },
    });
  } catch (err) {
    console.error(`[pdf] ${correlationId} failed`, err);
    return errorJson(500, "PDF generation failed", correlationId);
  }
}
