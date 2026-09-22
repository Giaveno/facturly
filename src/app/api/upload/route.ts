import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { OcrFake } from "@/adapters/ocr/ocr.fake";
import { getDb } from "@/lib/db/client";
import { classifyDbError } from "@/lib/db/errors";
import { processUpload } from "@/lib/pipeline/ingest";
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
 * Skeleton note: the OCR provider is the in-memory fake. The production
 * multimodal-LLM adapter (slice 4) replaces it behind the same OcrProvider
 * port — the route and pipeline do not change.
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

    const result = await processUpload(clientId, guarded.images, {
      db: getDb(),
      ocr: new OcrFake(),
    });

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
