import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { classifyDbError } from "@/lib/db/errors";
import { queueUpload } from "@/lib/pipeline/ingest";
import { inngest } from "@/lib/inngest/client";
import {
  isUnauthorizedError,
  requireAccountantSession,
} from "@/lib/auth/session";
import {
  assertSameOrigin,
  isForbiddenOriginError,
} from "@/lib/auth/origin";
import {
  MAX_TOTAL_BYTES,
  isUuid,
  validateUploadPhotos,
} from "@/lib/upload/guard";

function errorJson(status: number, message: string, correlationId: string) {
  return NextResponse.json({ error: message, correlationId }, { status });
}

/**
 * POST /api/upload — accepts receipt photos grouped under one client.
 *
 * Body: multipart/form-data
 *   - `clientId` (text) — a UUID identifying the target client company
 *   - `photos` (file, repeated) — the receipt images
 *
 * The ONLY untrusted boundary of the app: every request is size/type/magic-byte
 * validated BEFORE its bytes are buffered. Errors are logged server-side with a
 * correlation id and an opaque message is returned to the client (no DB detail,
 * no stack trace, no paths).
 *
 * OCR is ASYNC (C4): rows are persisted PENDING and one `ocr/row.pending`
 * Inngest event is sent per row; `processOcrRowJob` promotes them out of the
 * request path. The production multimodal-LLM adapter is slice-5 wiring.
 */
export async function POST(req: Request): Promise<Response> {
  const correlationId = randomUUID();
  try {
    // Pre-check the total body size from Content-Length before buffering the
    // whole multipart body via formData().
    const contentLength = Number(req.headers.get("content-length") ?? "NaN");
    if (Number.isFinite(contentLength) && contentLength > MAX_TOTAL_BYTES) {
      return errorJson(
        413,
        "Upload exceeds the total size limit",
        correlationId,
      );
    }

    // W2: same-origin (CSRF) check — the upload costs OCR money and writes rows.
    try {
      assertSameOrigin(req);
    } catch (err) {
      if (isForbiddenOriginError(err)) {
        return errorJson(403, "Cross-origin request rejected", correlationId);
      }
      throw err;
    }

    // C6: server-side auth — the middleware matcher is NOT the enforcement
    // point; this route must deny on its own even if the matcher ever regresses.
    try {
      await requireAccountantSession();
    } catch (err) {
      if (isUnauthorizedError(err)) {
        return errorJson(401, "Authentication required", correlationId);
      }
      throw err;
    }

    const form = await req.formData();

    const rawClientId = form.get("clientId");
    if (typeof rawClientId !== "string" || !isUuid(rawClientId.trim())) {
      return errorJson(400, "clientId must be a valid UUID", correlationId);
    }
    const clientId = rawClientId.trim();

    const files: File[] = [];
    for (const value of form.values()) {
      if (value instanceof File) files.push(value);
    }

    const guarded = await validateUploadPhotos(files);
    if (!guarded.ok) {
      return errorJson(guarded.status, guarded.message, correlationId);
    }

    // Persist PENDING rows (no inline OCR), then trigger the async OCR job.
    const result = await queueUpload(clientId, guarded.images, {
      db: getDb(),
    });
    for (const row of result.rows) {
      await inngest.send({
        name: "ocr/row.pending",
        data: { rowId: row.id },
      });
    }

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const status = classifyDbError(err);
    console.error(`[upload] ${correlationId} failed`, err);
    const message =
      status === 400
        ? "Upload could not be processed (unknown client or invalid reference)"
        : "Upload failed";
    return errorJson(status, message, correlationId);
  }
}
