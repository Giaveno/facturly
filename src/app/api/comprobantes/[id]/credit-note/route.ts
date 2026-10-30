import { fiscalDate } from "@/domain/fiscal-date";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { clients, comprobantes } from "@/lib/db/schema";
import { isUuid } from "@/lib/upload/guard";
import { requireAccountantSession, isUnauthorizedError } from "@/lib/auth/session";
import { assertSameOrigin, isForbiddenOriginError } from "@/lib/auth/origin";
import { buildArcaGateway } from "@/lib/emission/gateway";
import { emitComprobante, ComprobanteEmissionError } from "@/lib/emission/comprobante-emission-service";
import { creditNoteTypeFor, type InvoiceCbteTipo } from "@/domain/policy";
import { EmissionConfigurationError } from "@/adapters/arca/emissions";

function errorJson(status: number, error: string, correlationId: string) { return NextResponse.json({ error, correlationId }, { status }); }

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const correlationId = randomUUID(); const { id } = await params;
  if (!isUuid(id)) return errorJson(400, "Invalid comprobante id", correlationId);
  try { assertSameOrigin(req); } catch (error) { if (isForbiddenOriginError(error)) return errorJson(403, "Cross-origin request rejected", correlationId); throw error; }
  try { await requireAccountantSession(); } catch (error) { if (isUnauthorizedError(error)) return errorJson(401, "Authentication required", correlationId); throw error; }
  const empresaId = req.headers.get("x-empresa-id");
  if (!empresaId || !isUuid(empresaId)) return errorJson(403, "Company scope required", correlationId);
  try {
    const db = getDb();
    const [original] = await db.select().from(comprobantes).where(and(eq(comprobantes.id, id), eq(comprobantes.empresaId, empresaId)));
    if (!original || original.estado !== "aprobado" || original.cbteNro == null || original.cae == null || original.caeVto == null) return errorJson(422, "Only an approved comprobante can be annulled", correlationId);
    if (original.cbteTipo !== 1 && original.cbteTipo !== 6 && original.cbteTipo !== 11) return errorJson(422, "Only an invoice can be annulled", correlationId);
    const [company] = await db.select().from(clients).where(eq(clients.id, empresaId));
    if (!company) return errorJson(404, "Company not found", correlationId);
    const result = await emitComprobante({ db, gateway: buildArcaGateway(db) }, {
      empresaId, idempotencyKey: `credit-note:${original.id}`, comprobanteAsociadoId: original.id,
      emisorCuit: original.emisorCuit, emisorCondicionIva: original.emisorCondicionIva,
      cbteTipo: creditNoteTypeFor(original.cbteTipo as InvoiceCbteTipo), ptoVta: original.ptoVta, concepto: original.concepto,
      docTipo: original.docTipo, docNro: original.docNro, condicionIvaReceptor: original.condicionIvaReceptor,
      fecha: fiscalDate(), importeNetoCentavos: original.importeNetoCentavos,
      importeIvaCentavos: original.importeIvaCentavos, importeExentoCentavos: original.importeExentoCentavos,
      importeTributosCentavos: original.importeTributosCentavos, importeTotalCentavos: original.importeTotalCentavos,
      items: (Array.isArray(original.items) ? original.items : []) as never,
    });
    return NextResponse.json(result, { status: result.estado === "aprobado" ? 200 : 202 });
  } catch (error) {
    if (error instanceof EmissionConfigurationError) {
      return NextResponse.json({ error: error.publicMessage, correlationId, code: error.code, status: "deshabilitada" }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "Credit note failed";
    return errorJson(error instanceof ComprobanteEmissionError ? 422 : 500, message, correlationId);
  }
}
