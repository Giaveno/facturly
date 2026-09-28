/**
 * Excel/CSV export — reviewed/emitted rows, matching the review table fields.
 *
 * Monetary values are written as NUMERIC cells (centavos / 100) with an
 * explicit "0.00" number format. Writing them as TEXT strings would make Excel
 * silently exclude the column from SUM() — the W6 bug. The value stays exact to
 * the centavo: integer centavos are divided by 100 once (never accumulated as
 * floats) and the "0.00" format guarantees a 2-decimal display.
 */

import * as XLSX from "xlsx";
import { eq, inArray } from "drizzle-orm";
import { batches, clients, invoices, ocrRows, photos } from "@/lib/db/schema";
import type { Centavos } from "@/domain/money";
import type { Db } from "@/lib/db/types";

/** One export row — the review-table fields plus the payer's CUIT and date. */
export interface ExportRow {
  razonSocial: string;
  payerName: string;
  cuit: string | null;
  amountCentavos: Centavos;
  date: string;
  status: string;
}

/** Invoice statuses that are exportable (reviewed or emitted, not discarded). */
const EXPORTABLE_STATUSES = ["REVIEWED", "APPROVED", "EMITTED"] as const;

/** Lists reviewed/emitted rows with the review-table fields. */
export async function listExportRows(db: Db): Promise<ExportRow[]> {
  const rows = await db
    .select({
      razonSocial: clients.razonSocial,
      fields: ocrRows.fields,
      cuit: ocrRows.cuit,
      status: invoices.status,
    })
    .from(invoices)
    .innerJoin(ocrRows, eq(invoices.ocrRowId, ocrRows.id))
    .innerJoin(photos, eq(ocrRows.photoId, photos.id))
    .innerJoin(batches, eq(photos.batchId, batches.id))
    .innerJoin(clients, eq(batches.clientId, clients.id))
    .where(inArray(invoices.status, [...EXPORTABLE_STATUSES]))
    .orderBy(invoices.createdAt);

  return rows.map((r) => ({
    razonSocial: r.razonSocial,
    payerName: r.fields.name,
    cuit: r.cuit,
    amountCentavos: r.fields.amount,
    date: r.fields.date,
    status: r.status,
  }));
}

/** Writes export rows to an .xlsx workbook (amounts as numeric cells). */
export function exportRowsToXlsx(rows: ExportRow[]): Uint8Array {
  const header = ["Client", "Payer", "CUIT", "Amount", "Date", "Status"];
  const aoa: Array<Array<string | number>> = [header];
  for (const r of rows) {
    aoa.push([
      r.razonSocial,
      r.payerName,
      r.cuit ?? "",
      // Numeric pesos (integer centavos / 100) so Excel includes it in sums.
      r.amountCentavos / 100,
      r.date,
      r.status,
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // Explicit 2-decimal number format on the Amount column (index 3 → "D").
  const range = XLSX.utils.decode_range(ws["!ref"] ?? "A1");
  for (let row = 1; row <= range.e.r; row++) {
    const cell = ws[XLSX.utils.encode_cell({ r: row, c: 3 })];
    if (cell) cell.z = "0.00";
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Invoices");
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return new Uint8Array(buffer);
}
