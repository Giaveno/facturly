import { describe, expect, it } from "vitest";
import { matchesApprovalSnapshot, parseApprovalSnapshot } from "./approval-snapshot";
const snapshot={recipientMode:"identified" as const,taxRate:21,issuerCondition:"ri" as const,rowId:"row",name:"Payer",cuit:"30710145764",date:"2026-10-28",amount:100,issuerCuit:"20123456786",issuerName:"Issuer",ptoVta:1,environment:"homologacion" as const};
describe("displayed approval snapshot",()=>{
 it("accepts a complete snapshot and preserves exact displayed name",()=>{expect(parseApprovalSnapshot(snapshot)).toEqual(snapshot);expect(parseApprovalSnapshot({...snapshot,name:" Payer "}).name).toBe(" Payer ");expect(matchesApprovalSnapshot(snapshot,{...snapshot})).toBe(true);});
 it.each([{recipientMode:"consumer_final" as const},{taxRate:10.5},{issuerCondition:"exento" as const},{name:"Changed"},{cuit:"20123456786"},{date:"2026-10-27"},{amount:200},{rowId:"other"},{issuerCuit:"30710145764"},{issuerName:"Other issuer"},{ptoVta:2},{environment:"production" as const}])("rejects mismatched displayed fiscal context %j",change=>{expect(matchesApprovalSnapshot(snapshot,{...snapshot,...change})).toBe(false);});
 it.each([null,{}, {...snapshot,amount:0},{...snapshot,environment:"unknown"},{...snapshot,ptoVta:"1"}])("rejects malformed boundary %j",input=>{expect(()=>parseApprovalSnapshot(input)).toThrow();});
});
