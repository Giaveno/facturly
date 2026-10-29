import { isValidCuit } from "./cuit";
export class CorrectionValidationError extends Error {}
export type RecipientMode = "consumer_final" | "identified";
export const SUPPORTED_TAX_RATES = [10.5, 21, 27] as const;
// ARCA RG 1415 (current RG 5866/2026), verified 2026-10-28.
export const RECIPIENT_POLICY_VERSION = "arca-rg5866-2026-10-28";
export const ANONYMOUS_IDENTIFICATION_THRESHOLD_CENTS = 1_000_000_000;
export interface Corrections { name: string; cuit: string; date: string; amount: number; recipientMode: RecipientMode; taxRate: number | null }
export function validateCorrections(input: unknown): Corrections {
 if (!input || typeof input !== "object") throw new CorrectionValidationError("Datos inválidos.");
 const {name,cuit,date,amount,recipientMode,taxRate = null} = input as Partial<Corrections>;
 if (recipientMode !== "consumer_final" && recipientMode !== "identified") throw new CorrectionValidationError("Seleccione el modo de destinatario.");
 if (typeof name !== "string" || (recipientMode === "identified" && !name.trim()) || name.trim().length > 200) throw new CorrectionValidationError("Ingrese un nombre de hasta 200 caracteres.");
 const normalizedCuit = typeof cuit === "string" ? cuit.replace(/[ -]/g, "") : "";
 if (recipientMode === "identified" && (!/^\d{11}$/.test(normalizedCuit) || !isValidCuit(normalizedCuit))) throw new CorrectionValidationError("El CUIT no es válido.");
 if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date) throw new CorrectionValidationError("La fecha del comprobante no es válida.");
 if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) throw new CorrectionValidationError("El importe debe ser positivo y expresarse en centavos enteros.");
 if (recipientMode === "consumer_final" && amount >= ANONYMOUS_IDENTIFICATION_THRESHOLD_CENTS) throw new CorrectionValidationError("Desde $10.000.000 se requiere identificar al receptor. Este flujo solo admite CUIT con condición de IVA verificable; para DNI, CUIL u otros documentos use otro sistema habilitado.");
 if (taxRate !== null && !(SUPPORTED_TAX_RATES as readonly number[]).includes(taxRate)) throw new CorrectionValidationError("Seleccione una alícuota de IVA admitida (10,5%, 21% o 27%).");
 return {name:name.trim(),cuit:recipientMode === "identified" ? normalizedCuit : "",date,amount,recipientMode,taxRate};
}
