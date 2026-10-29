/**
 * Review-side row transitions. Slice 2 implements the CORRECTED transition (the
 * guard + invoice mapping are pure in `@/domain/emission`); the approve/emit
 * and reject transitions are invoice-level and land in slice 4.
 */

import { eq } from "drizzle-orm";
import { ocrRows } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

/**
 * Marks a BLOCKED row CORRECTED after a human fixes its extracted fields.
 *
 * Per the dual status machine, a CORRECTED row still requires explicit invoice review
 * confirmation (see `invoiceStatusForRow`). The invoice row itself is materialized
 * at review time by slice 4; here we only transition the OCR row.
 */
export async function markRowCorrected(
  db: Db,
  rowId: string,
): Promise<{ id: string; status: string }> {
  const [row] = await db
    .update(ocrRows)
    .set({ status: "CORRECTED" })
    .where(eq(ocrRows.id, rowId))
    .returning();

  if (!row) {
    throw new Error(`markRowCorrected: no OCR row with id ${rowId}`);
  }
  return { id: row.id, status: row.status };
}
