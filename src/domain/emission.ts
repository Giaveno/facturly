/**
 * Emission guard — the single enforcement point for "which OCR rows may ever be
 * emitted". The future emission path (slice 4) MUST call `assertRowEmittable`
 * (or `isRowEmittable`) before contacting ARCA; the review UI's disabled button
 * is a *hint*, not enforcement.
 *
 * This is the pure domain half of the dual status machine. The `ocr_row_status`
 * and `invoice_status` pgEnums live in the schema, but the transition policy is
 * expressed here so both the pipeline (slice 2/3) and the Inngest emission job
 * (slice 4) share one source of truth.
 */

/** OCR row status — mirrors the `ocr_row_status` pgEnum (incl. W7 FAILED). */
export type OcrRowStatus =
  | "PENDING"
  | "CONFIDENT"
  | "BLOCKED"
  | "CORRECTED"
  | "FAILED";

/**
 * Statuses under which a row must NEVER be emitted.
 *
 * `BLOCKED` is the confidence gate (fields below threshold). `REJECTED` is an
 * invoice-level status (the accountant discarded the invoice) — it can never be
 * a current `ocr_row_status` value, but we block it here anyway so the emission
 * path can pass either the row status or the invoice status through one guard
 * without a hole.
 */
const NON_EMITTABLE_STATUSES: ReadonlySet<string> = new Set([
  "BLOCKED",
  "REJECTED",
  // PENDING is the async OCR intermediate (slice-4 Inngest): a row that has not
  // finished OCR is not emittable either.
  "PENDING",
  // FAILED (ocr_row) — a crashed extraction is not emittable (W7).
  "FAILED",
  // EMIT_FAILED (invoice) — a permanent ARCA rejection is terminal (W2).
  "EMIT_FAILED",
]);

/** Thrown by `assertRowEmittable` when a row must not be emitted. */
export class RowNotEmittableError extends Error {
  readonly status: string;

  constructor(status: string) {
    super(`Cannot emit: OCR row status "${status}" is not emittable`);
    this.name = "RowNotEmittableError";
    this.status = status;
  }
}

/** True when a row in `status` may proceed to emission. */
export function isRowEmittable(status: string): boolean {
  return !NON_EMITTABLE_STATUSES.has(status);
}

/** Asserts a row is emittable, throwing `RowNotEmittableError` otherwise. */
export function assertRowEmittable(status: string): void {
  if (!isRowEmittable(status)) {
    throw new RowNotEmittableError(status);
  }
}

/** OCR state never confirms review. Only the explicit accountant action may do so. */
export function invoiceStatusForRow(status: OcrRowStatus): "PENDING" {
  void status;
  return "PENDING";
}
