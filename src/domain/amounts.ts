/**
 * Amount derivation — pure, integer-centavos only (never float).
 *
 * A bank-transfer receipt yields ONE total amount. ARCA's `FECAESolicitar`
 * still requires `ImpNeto`, `ImpIVA`, and `ImpTotal`, and the split differs by
 * comprobante type (see `discriminatesIva`):
 *
 *   - Factura A (1): IVA is itemized (alícuota 21% — single-rate, v1). The net
 *     and IVA are derived from the total.
 *   - Factura B/C (6/11): IVA is included but NOT itemized, so ImpNeto = total
 *     and ImpIVA = 0.
 *
 * The derivation uses integer arithmetic only. `total * 21` is an exact integer
 * product for totals below ~4.4e14 centavos (far above any realistic ARCA
 * invoice, which caps around 1e13 centavos), so the single round-half-up to the
 * nearest centavo has no floating-point drift.
 */

import type { Centavos } from "./money";
import type { CbteTipo } from "./policy";
import { discriminatesIva } from "./policy";

export interface AmountBreakdown {
  net: Centavos;
  iva: Centavos;
  total: Centavos;
}

/** Single VAT alícuota assumed in v1 (21%). See design "Open Questions". */
const VAT_RATE_NUMERATOR = 21;
const VAT_RATE_DENOMINATOR = 121; // 100 + 21

/**
 * Derives `{ net, iva, total }` from a gross total, in integer centavos.
 *
 * - Factura A: `iva = round_half_up(total * 21 / 121)`, `net = total - iva`.
 * - Factura B/C: `net = total`, `iva = 0`.
 */
export function deriveAmounts(
  totalCentavos: Centavos,
  cbteTipo: CbteTipo,
): AmountBreakdown {
  if (!Number.isSafeInteger(totalCentavos) || totalCentavos < 0) {
    throw new Error(`deriveAmounts: invalid total centavos ${totalCentavos}`);
  }
  if (discriminatesIva(cbteTipo)) {
    // Integer-only round-half-up of (total * 21) / 121.
    const numerator = totalCentavos * VAT_RATE_NUMERATOR;
    if (!Number.isSafeInteger(numerator)) {
      throw new Error(
        `deriveAmounts: total ${totalCentavos} overflows the safe-integer range`,
      );
    }
    const iva = Math.floor(
      (numerator + Math.floor(VAT_RATE_DENOMINATOR / 2)) / VAT_RATE_DENOMINATOR,
    );
    return { net: totalCentavos - iva, iva, total: totalCentavos };
  }
  return { net: totalCentavos, iva: 0, total: totalCentavos };
}
