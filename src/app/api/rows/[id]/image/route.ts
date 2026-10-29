import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { isUuid } from "@/lib/upload/guard";
import { requireAccountantSession, isUnauthorizedError } from "@/lib/auth/session";
import { loadReceiptImage } from "@/lib/review/image";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = {"Cache-Control":"private, no-store, max-age=0","X-Content-Type-Options":"nosniff","Cross-Origin-Resource-Policy":"same-origin"};
const error = (status: number,message: string) => NextResponse.json({error:message},{status,headers});
export async function GET(_req: Request,{params}: {params: Promise<{id:string}>}): Promise<Response> {
 const {id} = await params;
 if (!isUuid(id)) return error(400,"Identificador inválido.");
 try {
  await requireAccountantSession();
  const image = await loadReceiptImage(getDb(),id);
  if (!image) return error(404,"La imagen original no está disponible.");
  return new Response(new Uint8Array(image.bytes),{headers:{...headers,"Content-Type":image.mime}});
 } catch (err) {
  if (isUnauthorizedError(err)) return error(401,"Se requiere autenticación.");
  return error(500,"No se pudo cargar la imagen.");
 }
}
