import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { isUuid } from "@/lib/upload/guard";
import { requireAccountantSession, isUnauthorizedError } from "@/lib/auth/session";
import { assertSameOrigin, isForbiddenOriginError } from "@/lib/auth/origin";
import { LocalReceiptStorage } from "@/adapters/storage/local-receipt-storage";
import { deleteReceiptRow, ReceiptDeletionStateError } from "@/lib/review/delete";
const headers = {"Cache-Control": "private, no-store"};
const error = (status: number, message: string) => NextResponse.json({error: message}, {status, headers});

export async function DELETE(req: Request, {params}: {params: Promise<{id: string}>}): Promise<Response> {
  const {id} = await params;
  if (!isUuid(id)) return error(400, "Identificador inválido.");
  try {
    assertSameOrigin(req);
    await requireAccountantSession();
    const result = await deleteReceiptRow(getDb(), new LocalReceiptStorage(), id);
    return NextResponse.json(result, {status: result.cleanup === "pending" ? 202 : 200, headers});
  } catch (err) {
    if (isForbiddenOriginError(err)) return error(403, "Solicitud de otro origen rechazada.");
    if (isUnauthorizedError(err)) return error(401, "Se requiere autenticación.");
    if (err instanceof ReceiptDeletionStateError) return error(409, err.message);
    return error(500, "No se pudo eliminar el comprobante.");
  }
}
