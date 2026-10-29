import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { requireAccountantSession, isUnauthorizedError } from "@/lib/auth/session";
import { assertSameOrigin, isForbiddenOriginError } from "@/lib/auth/origin";
import { getDb } from "@/lib/db/client";
import { checkCredentialConnection, ConnectionCheckError } from "@/lib/credentials/connection-check";

export const runtime = "nodejs";
export async function POST(req: Request): Promise<Response> {
  const correlationId = randomUUID();
  const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
  const error = (status: number, message: string) => json({ error: message, correlationId }, status);
  try {
    // This browser-only diagnostic requires Origin, unlike server-to-server routes.
    if (!req.headers.get("origin")) return error(403, "Origin required");
    assertSameOrigin(req);
    await requireAccountantSession();
    if (process.env.ARCA_ENV !== "homologacion") return error(409, "La prueba solo está disponible con ARCA_ENV=homologacion.");
    let body: unknown;
    try { body = await req.json(); } catch { return error(400, "Invalid request"); }
    if (!body || typeof body !== "object" || Object.keys(body).length !== 1 || !("fingerprint" in body) || typeof body.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(body.fingerprint)) return error(400, "Invalid public certificate identity");
    return json(await checkCredentialConnection(getDb(), process.env, body.fingerprint));
  } catch (err) {
    if (isForbiddenOriginError(err)) return error(403, "Cross-origin request rejected");
    if (isUnauthorizedError(err)) return error(401, "Authentication required");
    if (err instanceof ConnectionCheckError) {
      if (err.code === "changed") return error(409, "El certificado cambió. Actualice la página antes de volver a probar.");
      if (err.code === "timeout") return error(504, "La prueba superó el tiempo de espera. Puede reintentar.");
      return error(409, "La prueba solo está disponible en homologación.");
    }
    // Never log the raw exception: XML, PEM, credentials and upstream messages are untrusted.
    return error(500, "No se pudo comprobar la autenticación en homologación.");
  }
}
