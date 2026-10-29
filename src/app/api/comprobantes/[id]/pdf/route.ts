import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { isUuid } from "@/lib/upload/guard";
import { isUnauthorizedError, requireAccountantSession } from "@/lib/auth/session";
import { buildComprobantePdfModel, renderInvoicePdf } from "@/pdf/render";
import { loadApprovedComprobantePdfInput } from "@/lib/invoices/read-model";
function errorJson(status: number, error: string, correlationId: string) { return NextResponse.json({ error, correlationId }, { status }); }
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const correlationId = randomUUID(); const { id } = await params;
  if (!isUuid(id)) return errorJson(400, "Invalid comprobante id", correlationId);
  try { await requireAccountantSession(); } catch (error) { if (isUnauthorizedError(error)) return errorJson(401, "Authentication required", correlationId); throw error; }
  try {
    const scope = req.headers.get("x-empresa-id") ?? new URL(req.url).searchParams.get("empresaId");
    if (!scope || !isUuid(scope)) return errorJson(403, "Comprobante company scope required", correlationId);
    const input = await loadApprovedComprobantePdfInput(getDb(), id, scope);
    if (!input) return errorJson(404, "Comprobante not found or not approved", correlationId);
    const pdf = await renderInvoicePdf(buildComprobantePdfModel(input));
    return new NextResponse(Buffer.from(pdf), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="comprobante-${input.ptoVta}-${input.cbteNro}.pdf"` } });
  } catch (error) { console.error(`[comprobante-pdf] ${correlationId} failed`, error); return errorJson(500, "PDF generation failed", correlationId); }
}
