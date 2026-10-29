import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { isUuid } from "@/lib/upload/guard";
import { requireAccountantSession, isUnauthorizedError } from "@/lib/auth/session";
import { assertSameOrigin, isForbiddenOriginError } from "@/lib/auth/origin";
import { saveCorrections, validateCorrections, CorrectionValidationError, CorrectionStateError, CorrectionNotFoundError } from "@/lib/review/corrections";
const error = (status: number, message: string) => NextResponse.json({error:message},{status,headers:{"Cache-Control":"private, no-store"}});
export async function POST(req: Request,{params}: {params: Promise<{id:string}>}): Promise<Response> {
 const {id} = await params;
 if (!isUuid(id)) return error(400,"Identificador inválido.");
 try {
  assertSameOrigin(req);
  await requireAccountantSession();
  let input: unknown;
  try { input = await req.json(); } catch { return error(400,"El cuerpo de la solicitud no es válido."); }
  const values = validateCorrections(input);
  return NextResponse.json(await saveCorrections(getDb(),id,values),{headers:{"Cache-Control":"private, no-store"}});
 } catch (err) {
  if (isForbiddenOriginError(err)) return error(403,"Solicitud de otro origen rechazada.");
  if (isUnauthorizedError(err)) return error(401,"Se requiere autenticación.");
  if (err instanceof CorrectionValidationError) return error(400,err.message);
  if (err instanceof CorrectionNotFoundError) return error(404,"Comprobante no encontrado.");
  if (err instanceof CorrectionStateError) return error(409,err.message || "El comprobante no admite cambios.");
  return error(500,"No se pudieron guardar las correcciones.");
 }
}
