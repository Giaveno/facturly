import { NextResponse } from "next/server";
import { requireAccountantSession, isUnauthorizedError } from "@/lib/auth/session";
import { assertSameOrigin, isForbiddenOriginError } from "@/lib/auth/origin";
import { isUuid } from "@/lib/upload/guard";
import { getDb } from "@/lib/db/client";
import { consultReservedInvoice, InvoiceConsultationError } from "@/lib/invoices/reconciliation";
export const runtime = "nodejs";
export async function POST(req: Request, { params }: {
    params: Promise<{
        id: string;
    }>;
}): Promise<Response> {
    const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
    try {
        const { id } = await params;
        if (!isUuid(id))
            return json({ error: "Invalid invoice id" }, 400);
        if (!req.headers.get("origin"))
            return json({ error: "Origin required" }, 403);
        assertSameOrigin(req);
        await requireAccountantSession();
        if (process.env.ARCA_ENV !== "homologacion")
            return json({ error: "La consulta requiere homologación.", code: "environment" }, 409);
        // Caller controls only the route invoice ID, never fiscal identity or credentials.
        if (Number(req.headers.get("content-length")) > 32 || !req.body)
            return json({ error: "Invalid request" }, 400);
        const reader = req.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                length += value.byteLength;
                if (length > 32)
                    return json({ error: "Invalid request" }, 400);
                chunks.push(value);
            }
        }
        finally {
            void reader.cancel().catch(() => { });
        }
        const text = Buffer.concat(chunks).toString("utf8");
        let body: unknown;
        try {
            body = JSON.parse(text);
        }
        catch {
            return json({ error: "Invalid request" }, 400);
        }
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length)
            return json({ error: "Invalid request" }, 400);
        return json(await consultReservedInvoice(getDb(), process.env, id));
    }
    catch (error) {
        if (isForbiddenOriginError(error))
            return json({ error: "Cross-origin request rejected" }, 403);
        if (isUnauthorizedError(error))
            return json({ error: "Authentication required" }, 401);
        if (error instanceof InvoiceConsultationError) {
            const messages = {
                environment: "No se pudo verificar que la reserva corresponde a homologación. No se consultó ARCA.",
                not_found: "La reserva no está disponible para consulta.",
                credentials: "No hay credenciales utilizables. Revise las credenciales guardadas.",
                changed: "La reserva o las credenciales cambiaron. Actualice la página.",
                cooldown: "Espere unos segundos antes de volver a consultar.",
                upstream: "No se pudo verificar el estado en ARCA. El resultado fiscal sigue siendo desconocido.",
            };
            return json({ status: "provider-error", error: messages[error.code], code: error.code, diagnostic: error.diagnostic }, error.code === "not_found" ? 404 : error.code === "cooldown" ? 429 : error.code === "upstream" ? 502 : 409);
        }
        return json({ error: "No se pudo verificar el estado en ARCA. No se modificó la factura." }, 500);
    }
}
