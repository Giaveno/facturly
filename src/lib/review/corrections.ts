import { eq } from "drizzle-orm";
import { invoices, ocrRows } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { writeAudit } from "@/lib/audit/audit";
import { materializeInvoice } from "./workflow";
import { upsertPayer } from "@/lib/db/payers";
import { withRowLock } from "./locks";

export { validateCorrections, CorrectionValidationError } from "@/domain/receipt";
import { validateCorrections } from "@/domain/receipt";
export class CorrectionStateError extends Error {}
export class CorrectionNotFoundError extends Error {}
export async function saveCorrections(db: Db, rowId: string, input: unknown) {
 const values = validateCorrections(input);
 return withRowLock(db,rowId,async tx => {
  const [row] = await tx.select().from(ocrRows).where(eq(ocrRows.id,rowId));
  if (!row) throw new CorrectionNotFoundError("Comprobante no encontrado.");
  if (!["CONFIDENT","BLOCKED","CORRECTED"].includes(row.status)) throw new CorrectionStateError("La extracción debe estar completa para editar.");
  const invoice = await materializeInvoice(tx,rowId);
  if (!["PENDING","REVIEWED"].includes(invoice.status)) throw new CorrectionStateError("El comprobante ya no admite cambios.");
  if (values.recipientMode === "identified") await upsertPayer(tx,{name:values.name,cuit:values.cuit,cbu:row.fields.cbu,cvu:row.fields.cvu,alias:row.fields.alias});
  const changedFields = (["name","date","amount"] as const).filter(key=> row.fields[key] !== values[key]);
  const cuit = values.recipientMode === "identified" ? values.cuit : null;
  const cuitChanged = row.cuit !== cuit;
  const modeChanged = row.recipientMode !== values.recipientMode;
  const rateChanged = row.taxRate !== values.taxRate;
  await tx.update(ocrRows).set({ fields:{...row.fields,name:values.name,date:values.date,amount:values.amount},cuit,cuitSource:cuit === null ? null : cuitChanged ? "manual" : row.cuitSource,recipientMode:values.recipientMode,recipientModeSource:modeChanged ? "manual" : row.recipientModeSource,taxRate:values.taxRate,status:"CORRECTED" }).where(eq(ocrRows.id,rowId));
  await tx.update(invoices).set({status:"PENDING",importeTotalCentavos:values.amount}).where(eq(invoices.id,invoice.id));
  await writeAudit(tx,{actor:"accountant",action:"row.corrected",rowId,invoiceId:invoice.id,payload:{source:"manual",changedFields:[...changedFields,...(cuitChanged?["cuit"]:[]),...(modeChanged?["recipientMode"]:[]),...(rateChanged?["taxRate"]:[])],before:{...row.fields,cuit:row.cuit,recipientMode:row.recipientMode,taxRate:row.taxRate},after:values}});
  return {rowId,invoiceId:invoice.id,status:"CORRECTED",invoiceStatus:"PENDING"};
 });
}
