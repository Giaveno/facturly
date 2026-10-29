import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { requireAccountantSession, isUnauthorizedError } from "@/lib/auth/session";
import { assertSameOrigin, isForbiddenOriginError } from "@/lib/auth/origin";
import { getDb } from "@/lib/db/client";
import { lookupCuit, normalizeLookupCuit, PadronLookupError } from "@/lib/padron/lookup";
import { safeQueryDiagnostic } from "@/adapters/arca/query-diagnostics";

export const runtime = "nodejs";
class RequestBodyTimeout extends Error {}
async function readRequestBody(req: Request): Promise<unknown> {
  const reader = req.body?.getReader();
  if (!reader || Number(req.headers.get("content-length")) > 1024) throw new Error("Invalid request");
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new RequestBodyTimeout()); void reader.cancel().catch(() => {}); }, 2_000); });
  try {
    return await Promise.race([(async () => {
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > 1024) throw new Error("Invalid request"); chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    })(), timeout]);
  } finally { clearTimeout(timer!); void reader.cancel().catch(() => {}); }
}
export async function POST(req: Request): Promise<Response> {
  const correlationId = randomUUID();
  const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
  const error = (status: number, message: string, failure?: PadronLookupError) => json({ error: message, correlationId, ...(failure ? { code: failure.code, diagnostic: safeQueryDiagnostic(failure.diagnostic) } : {}) }, status);
  try {
    if (!req.headers.get("origin")) return error(403, "Se requiere el origen de la solicitud.");
    assertSameOrigin(req);
    await requireAccountantSession();
    // Fail closed before any DB, secret, or provider access.
    if (process.env.ARCA_ENV !== "homologacion") return error(409, "La consulta requiere ARCA_ENV=homologacion.", new PadronLookupError("environment"));
    // Bound request bytes AND elapsed time independently of untrusted headers.
    let body: unknown;
    try { body = await readRequestBody(req); }
    catch (err) { return err instanceof RequestBodyTimeout ? error(408, "La recepción de la solicitud superó el tiempo de espera.", new PadronLookupError("timeout")) : error(400, "Solicitud inválida o demasiado extensa."); }
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 2 || !("cuit" in body) || !("fingerprint" in body) || typeof body.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(body.fingerprint)) return error(400, "CUIT o identidad del certificado inválidos.");
    const cuit = normalizeLookupCuit(body.cuit);
    if (!cuit) return error(400, "Ingrese un CUIT válido, incluido su dígito verificador.");
    return json(await lookupCuit(getDb(), process.env, cuit, body.fingerprint));
  } catch (err) {
    if (isForbiddenOriginError(err)) return error(403, "Solicitud de otro origen rechazada.");
    if (isUnauthorizedError(err)) return error(401, "Se requiere una sesión autenticada.");
    if (err instanceof PadronLookupError) {
      const failures: Record<PadronLookupError["code"], [number, string]> = {
        environment: [409, "La consulta solo está disponible en homologación."],
        invalid_cuit: [400, "El CUIT no es válido."],
        credentials: [409, "No hay credenciales utilizables con CUIT identificable. Revise el certificado y la clave guardados."],
        changed: [409, "Las credenciales cambiaron. Actualice la página antes de consultar."],
        timeout: [504, "La consulta superó el tiempo de espera."],
        cooldown: [429, "Espere 15 segundos antes de consultar otro CUIT."],
        upstream: [502, "Falló la consulta al Padrón de homologación."],
      };
      const [status, message] = failures[err.code]; return error(status, message, err);
    }
    // Never log/expose raw XML, exception messages, certificate material or PII.
    return error(500, "No se pudo consultar el Padrón de homologación.");
  }
}
