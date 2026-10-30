import { validateCorrections, type Corrections } from "./receipt";
import type { CondicionIVA } from "./policy";
export interface ApprovalSnapshot extends Corrections {
 rowId: string;
 issuerCuit: string;
 issuerName: string;
 issuerCondition: CondicionIVA;
 ptoVta: number;
 environment: "production" | "homologacion";
 /** Frozen detailed items, when available; otherwise approval uses one total line. */
 itemSnapshot?: string;
}
export function parseApprovalSnapshot(input: unknown): ApprovalSnapshot {
 const fields=validateCorrections(input);
 const value=input as Partial<ApprovalSnapshot>;
 if (typeof value.rowId!=="string" || typeof value.issuerCuit!=="string" || typeof value.issuerName!=="string" || !["ri","monotributista","exento"].includes(value.issuerCondition??"") || typeof value.ptoVta!=="number" || !Number.isInteger(value.ptoVta) || !["production","homologacion"].includes(value.environment??"")) throw new Error("Invalid approval snapshot");
 if (value.itemSnapshot !== undefined && typeof value.itemSnapshot !== "string") throw new Error("Invalid item snapshot");
 return {...fields,name:value.name!,rowId:value.rowId,issuerCuit:value.issuerCuit,issuerName:value.issuerName,issuerCondition:value.issuerCondition!,ptoVta:value.ptoVta,environment:value.environment!, ...(value.itemSnapshot === undefined ? {} : { itemSnapshot: value.itemSnapshot })};
}
export function matchesApprovalSnapshot(expected: ApprovalSnapshot, actual: ApprovalSnapshot): boolean {
 return [...new Set([...Object.keys(actual), ...Object.keys(expected)])].every(key=>expected[key as keyof ApprovalSnapshot]===actual[key as keyof ApprovalSnapshot]);
}
/** Canonical fiscal context shared by approval and dispatch guards. OCR identity
 * stays available as evidence, but anonymous CUIT is never a fiscal identifier. */
export function createApprovalSnapshot(
 row: {id:string;fields:{name:string;date:string;amount:number};cuit:string|null;recipientMode:Corrections["recipientMode"];taxRate:number|null},
 client: {cuit:string;razonSocial:string;ptoVta:number;condicionIva:CondicionIVA},
 environment: ApprovalSnapshot["environment"],
): ApprovalSnapshot {
 const items = (row.fields as typeof row.fields & {items?: unknown}).items;
 return {rowId:row.id,name:row.fields.name,cuit:row.recipientMode === "identified" ? (row.cuit ?? "").replace(/[ -]/g, "") : "",recipientMode:row.recipientMode,taxRate:row.taxRate,date:row.fields.date,amount:row.fields.amount,issuerCuit:client.cuit,issuerName:client.razonSocial,issuerCondition:client.condicionIva,ptoVta:client.ptoVta,environment,...(Array.isArray(items) && items.length ? {itemSnapshot:JSON.stringify(items)} : {})};
}
