import { deriveAmounts } from "./amounts";
import { cbteTipo, type CondicionIVA } from "./policy";
import type { RecipientMode } from "./receipt";

export interface ReviewFiscalInput {
  issuerCondition: CondicionIVA;
  recipientMode: RecipientMode;
  cuit: string | null;
  taxRate: number | null;
  fields: { name: string; amount: number };
}

/** Shared by approval and its read-only preview; unresolved registry data stays null. */
export function buildReviewFiscalData(input: ReviewFiscalInput, condition: CondicionIVA | null) {
  const receptor = input.recipientMode === "consumer_final" ? "consumidorFinal" : condition;
  const type = receptor ? cbteTipo(input.issuerCondition, receptor).cbteTipo
    : ["exento", "monotributista"].includes(input.issuerCondition) ? 11 : null;
  const amounts = deriveAmounts(input.fields.amount, type ?? 6, input.taxRate);
  return {
    cbteTipo: type,
    receptorDocTipo: input.recipientMode === "consumer_final" ? 99 : 80,
    receptorDocNro: input.recipientMode === "consumer_final" ? 0 : Number(input.cuit?.replace(/[ -]/g, "")),
    receptorRazonSocial: input.recipientMode === "consumer_final" ? "Consumidor Final" : input.fields.name,
    condicionIvaReceptorId: receptor ? ({ ri: 1, exento: 4, consumidorFinal: 5, monotributista: 6 } as const)[receptor] : null,
    taxRate: type === 11 ? null : input.taxRate,
    amounts,
  };
}
