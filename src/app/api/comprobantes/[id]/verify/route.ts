import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { comprobantes } from "@/lib/db/schema";
import { requireAccountantSession, isUnauthorizedError } from "@/lib/auth/session";
import { assertSameOrigin, isForbiddenOriginError } from "@/lib/auth/origin";
import { isUuid } from "@/lib/upload/guard";
import { buildArcaGateway } from "@/lib/emission/gateway";
import { verifyComprobante, ComprobanteEmissionError } from "@/lib/emission/comprobante-emission-service";

export const maxDuration = 120;
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    assertSameOrigin(req);
    await requireAccountantSession();
    const { id } = await params;
    const empresaId = req.headers.get("x-empresa-id");
    if (!isUuid(id) || !empresaId || !isUuid(empresaId)) return NextResponse.json({ error: "El comprobante y la empresa deben tener identificadores válidos." }, { status: 400 });
    const db = getDb();
    const [row] = await db.select({ id: comprobantes.id }).from(comprobantes).where(and(eq(comprobantes.id, id), eq(comprobantes.empresaId, empresaId), eq(comprobantes.ambiente, "homologacion")));
    if (!row) return NextResponse.json({ error: "No se encontró el comprobante de esta empresa." }, { status: 404 });
    const result = await verifyComprobante({ db, gateway: buildArcaGateway(db) }, id, empresaId);
    return NextResponse.json(result);
  } catch (error) {
    if (isUnauthorizedError(error)) return NextResponse.json({ error: "Inicie sesión para verificar el comprobante." }, { status: 401 });
    if (isForbiddenOriginError(error)) return NextResponse.json({ error: "Origen de solicitud no permitido." }, { status: 403 });
    if (error instanceof ComprobanteEmissionError) return NextResponse.json({ error: error.message }, { status: 409 });
    return NextResponse.json({ error: "No se pudo verificar el comprobante en ARCA; no se reintentó ninguna emisión." }, { status: 502 });
  }
}
