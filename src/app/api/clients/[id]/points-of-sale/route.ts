import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { requireAccountantSession, isUnauthorizedError } from "@/lib/auth/session";
import { assertSameOrigin, isForbiddenOriginError } from "@/lib/auth/origin";
import { getDb } from "@/lib/db/client";
import { isUuid } from "@/lib/upload/guard";
import { checkClientPointsOfSale, PointsOfSaleError } from "@/lib/clients/points-of-sale";
import { safeQueryDiagnostic } from "@/adapters/arca/query-diagnostics";

export const runtime = "nodejs";
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const correlationId = randomUUID();
  const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
  const error = (status: number, message: string, failure?: PointsOfSaleError) => json({ error: message, correlationId, ...(failure ? { code: failure.code, diagnostic: safeQueryDiagnostic(failure.diagnostic) } : {}) }, status);
  try {
    const { id } = await params;
    if (!isUuid(id)) return error(400, "Invalid client id");
    if (!req.headers.get("origin")) return error(403, "Origin required");
    assertSameOrigin(req);
    await requireAccountantSession();
    // No credential or database access before this explicit fail-closed guard.
    if (process.env.ARCA_ENV !== "homologacion") return error(409, "La consulta solo está disponible con ARCA_ENV=homologacion.", new PointsOfSaleError("environment"));
    let body: unknown;
    try { body = await req.json(); } catch { return error(400, "Invalid request"); }
    if (!body || typeof body !== "object" || Object.keys(body).length !== 1 || !("fingerprint" in body) || typeof body.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(body.fingerprint)) return error(400, "Invalid public certificate identity");
    return json(await checkClientPointsOfSale(getDb(), process.env, id, body.fingerprint));
  } catch (err) {
    if (isForbiddenOriginError(err)) return error(403, "Cross-origin request rejected");
    if (isUnauthorizedError(err)) return error(401, "Authentication required");
    if (err instanceof PointsOfSaleError) {
      switch (err.code) {
        case "not_found": return error(404, "El cliente ya no existe.", err);
        case "credentials": return error(409, "No hay credenciales utilizables. Revise el certificado y la clave guardados.", err);
        case "changed": return error(409, "El cliente o las credenciales cambiaron. Actualice la página antes de consultar.", err);
        case "environment": return error(409, "La consulta solo está disponible en homologación.", err);
        case "timeout": return error(504, "La consulta superó el tiempo de espera. Puede reintentar.", err);
        case "cooldown": return error(429, "Espere unos segundos antes de volver a consultar.", err);
        case "upstream": return error(502, "Falló la consulta de puntos de venta en homologación.", err);
      }
    }
    // Never log or expose raw exceptions, XML, keys or upstream fault text.
    return error(500, "No se pudieron consultar los puntos de venta en homologación.");
  }
}
