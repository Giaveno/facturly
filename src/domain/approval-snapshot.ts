import { validateCorrections, type Corrections } from "./receipt";
import type { CondicionIVA } from "./policy";
export interface ApprovalSnapshot extends Corrections {
 rowId: string;
 issuerCuit: string;
 issuerName: string;
 issuerCondition: CondicionIVA;
 ptoVta: number;
 environment: "production" | "homologacion";
}
export function parseApprovalSnapshot(input: unknown): ApprovalSnapshot {
 const fields=validateCorrections(input);
 const value=input as Partial<ApprovalSnapshot>;
 if (typeof value.rowId!=="string" || typeof value.issuerCuit!=="string" || typeof value.issuerName!=="string" || !["ri","monotributista","exento"].includes(value.issuerCondition??"") || typeof value.ptoVta!=="number" || !Number.isInteger(value.ptoVta) || !["production","homologacion"].includes(value.environment??"")) throw new Error("Invalid approval snapshot");
 return {...fields,name:value.name!,rowId:value.rowId,issuerCuit:value.issuerCuit,issuerName:value.issuerName,issuerCondition:value.issuerCondition!,ptoVta:value.ptoVta,environment:value.environment!};
}
export function matchesApprovalSnapshot(expected: ApprovalSnapshot, actual: ApprovalSnapshot): boolean {
 return (Object.keys(actual) as (keyof ApprovalSnapshot)[]).every(key=>expected[key]===actual[key]);
}
/** Canonical fiscal context shared by approval and dispatch guards. OCR identity
 * stays available as evidence, but anonymous CUIT is never a fiscal identifier. */
export function createApprovalSnapshot(
 row: {id:string;fields:{name:string;date:string;amount:number};cuit:string|null;recipientMode:Corrections["recipientMode"];taxRate:number|null},
 client: {cuit:string;razonSocial:string;ptoVta:number;condicionIva:CondicionIVA},
 environment: ApprovalSnapshot["environment"],
): ApprovalSnapshot {
 return {rowId:row.id,name:row.fields.name,cuit:row.recipientMode === "identified" ? (row.cuit ?? "").replace(/[ -]/g, "") : "",recipientMode:row.recipientMode,taxRate:row.taxRate,date:row.fields.date,amount:row.fields.amount,issuerCuit:client.cuit,issuerName:client.razonSocial,issuerCondition:client.condicionIva,ptoVta:client.ptoVta,environment};
}
