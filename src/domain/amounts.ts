/** A/B need taxable net and IVA even when B displays a gross price. */
import type { Centavos } from "./money";
import { invoiceTypeForCreditNote, isCreditNoteCbteTipo, type CbteTipo } from "./policy";
import { SUPPORTED_TAX_RATES } from "./receipt";
export interface AmountBreakdown { net: Centavos; iva: Centavos; total: Centavos }
export function deriveAmounts(totalCentavos: Centavos, cbteTipo: CbteTipo, taxRate?: number | null): AmountBreakdown {
 if (!Number.isSafeInteger(totalCentavos) || totalCentavos < 0) throw new Error(`deriveAmounts: invalid total centavos ${totalCentavos}`);
 const invoiceType = isCreditNoteCbteTipo(cbteTipo) ? invoiceTypeForCreditNote(cbteTipo) : cbteTipo;
 if (invoiceType === 11) return {net:totalCentavos,iva:0,total:totalCentavos};
 const rate = taxRate ?? null;
 if (rate === null || !(SUPPORTED_TAX_RATES as readonly number[]).includes(rate)) throw new Error("Seleccione una alícuota de IVA para la operación gravada.");
 const numerator = BigInt(totalCentavos) * BigInt(rate * 10);
 const denominator = BigInt(1000 + rate * 10);
 const iva = Number((numerator + denominator / BigInt(2)) / denominator);
 return {net:totalCentavos-iva,iva,total:totalCentavos};
}
