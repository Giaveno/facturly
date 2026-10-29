import { describe, expect, it } from "vitest";
import { validateCorrections } from "./receipt";
import { deriveAmounts } from "./amounts";

const base = { name: "", cuit: "", date: "2026-10-28", amount: 999999999, recipientMode: "consumer_final", taxRate: null };
describe("explicit recipient and tax policy", () => {
 it("allows anonymous consumer final below the identification boundary without inventing a name", () => {
  expect(validateCorrections(base)).toEqual(base);
 });
 it.each([1000000000,1000000001])("requires identification at/above ARS 10m (%i cents)", amount => {
  expect(() => validateCorrections({...base,amount})).toThrow(/identific/i);
 });
 it("does not silently infer a recipient mode or use stale CUIT in anonymous mode", () => {
  expect(() => validateCorrections({...base,recipientMode:undefined})).toThrow();
  expect(validateCorrections({...base,cuit:"30710145764"}).cuit).toBe("");
 });
 it("normalizes and checksum-validates a manually identified recipient", () => {
  expect(validateCorrections({...base,name:"Payer",recipientMode:"identified",cuit:"30-71014576-4"}).cuit).toBe("30710145764");
  expect(() => validateCorrections({...base,name:"Payer",recipientMode:"identified",cuit:"30710145765"})).toThrow(/CUIT/);
  expect(() => validateCorrections({...base,name:"Payer",recipientMode:"identified",cuit:"x30710145764"})).toThrow(/CUIT/);
  expect(() => validateCorrections({...base,name:"Payer",recipientMode:"identified",cuit:"30.71014576.4"})).toThrow(/CUIT/);
 });
 it("requires an explicit supported rate for taxable B and derives its net/IVA", () => {
  expect(() => deriveAmounts(12100,6)).toThrow(/alícuota/);
  expect(() => deriveAmounts(12100,1)).toThrow(/alícuota/);
  expect(deriveAmounts(12100,6,21)).toEqual({total:12100,net:10000,iva:2100});
  expect(deriveAmounts(11050,6,10.5)).toEqual({total:11050,net:10000,iva:1050});
  expect(deriveAmounts(12700,1,27)).toEqual({total:12700,net:10000,iva:2700});
  expect(deriveAmounts(12100,11)).toEqual({total:12100,net:12100,iva:0});
 });
});
