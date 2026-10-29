import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { isUuid } from "@/lib/upload/guard";
import { getDb } from "@/lib/db/client";
import { comprobantes } from "@/lib/db/schema";
import { requireAccountantSession, isUnauthorizedError } from "@/lib/auth/session";
import { assertSameOrigin, isForbiddenOriginError } from "@/lib/auth/origin";
import { buildArcaGateway } from "@/lib/emission/gateway";
import { emitComprobante, ComprobanteEmissionError, SERIES_BLOCKED_MESSAGE, RECONCILIATION_UNCERTAIN_REASON } from "@/lib/emission/comprobante-emission-service";
import { ArcaError } from "@/adapters/arca/errors";

function errorJson(status: number, error: string, correlationId: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, correlationId, ...extra }, { status });
}

async function auth(correlationId: string, req?: Request) {
  if (req) {
    try { assertSameOrigin(req); } catch (err) { if (isForbiddenOriginError(err)) return errorJson(403, "Cross-origin request rejected", correlationId); throw err; }
  }
  try { await requireAccountantSession(); } catch (err) { if (isUnauthorizedError(err)) return errorJson(401, "Authentication required", correlationId); throw err; }
  return null;
}

export async function GET(req: Request): Promise<Response> {
  const correlationId = randomUUID();
  const denied = await auth(correlationId);
  if (denied) return denied;
  const empresaId = new URL(req.url).searchParams.get("empresaId") ?? req.headers.get("x-empresa-id");
  if (!empresaId || !isUuid(empresaId)) return errorJson(403, "Company scope required", correlationId);
  try {
    const rows = await getDb().select({ id: comprobantes.id, empresaId: comprobantes.empresaId, estado: comprobantes.estado, cbteTipo: comprobantes.cbteTipo, cbteNro: comprobantes.cbteNro, cae: comprobantes.cae, caeVto: comprobantes.caeVto, errores: comprobantes.errores, ambiente: comprobantes.ambiente, createdAt: comprobantes.createdAt }).from(comprobantes).where(eq(comprobantes.empresaId, empresaId)).orderBy(comprobantes.createdAt);
    return NextResponse.json(rows);
  } catch (err) { console.error(`[comprobantes] ${correlationId} list failed`, err); return errorJson(500, "Failed to list comprobantes", correlationId); }
}

export async function POST(req: Request): Promise<Response> {
  const correlationId = randomUUID();
  const denied = await auth(correlationId, req);
  if (denied) return denied;
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const headerKey = req.headers.get("Idempotency-Key")?.trim();
    const idempotencyKey = headerKey || (typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "");
    if (!idempotencyKey) return errorJson(400, "Idempotency-Key is required", correlationId);
    const result = await emitComprobante({ db: getDb(), gateway: buildArcaGateway(getDb()), environment: undefined }, { ...body, idempotencyKey, empresaId: String(body.empresaId ?? "") } as never);
    return NextResponse.json(result, { status: result.estado === "aprobado" ? 200 : 202 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Emission failed";
    const arca = err instanceof ArcaError ? { code: err.code, message: err.message, stage: err.stage, category: err.category, providerCodes: err.providerCodes } : undefined;
    const blocked = message === SERIES_BLOCKED_MESSAGE || message === RECONCILIATION_UNCERTAIN_REASON || /incierto|conciliaci/i.test(message);
    const fiscal = arca ? `${arca.code ?? "ARCA"}: ${arca.message}` : message;
    return errorJson(blocked ? 409 : err instanceof ComprobanteEmissionError ? 422 : 500, fiscal, correlationId, { code: blocked ? "SERIES_BLOCKED" : arca?.code, status: blocked ? "incierto" : undefined, arca });
  }
}

