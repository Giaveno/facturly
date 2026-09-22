/**
 * CUIT validation — Mod-11 check digit.
 *
 * A CUIT is 11 digits: 2-digit type prefix + 8-digit document number + 1 check
 * digit. The check digit is computed over the first 10 digits with the fixed
 * weight sequence [5,4,3,2,7,6,5,4,3,2] (left-to-right), which is equivalent
 * to the "multiply by 2..7 from the right" description in the AFIP spec.
 */

export const CUIT_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2] as const;

/**
 * Valid type prefixes: 20/23/24/25/26/27 (personas físicas) and 30/33/34
 * (personas jurídicas). 23/33 are the "renumbered" forms used when the raw
 * Mod-11 check would otherwise be 10 (remainder === 1).
 */
export const CUIT_PREFIXES: ReadonlySet<number> = new Set([
  20, 23, 24, 25, 26, 27, 30, 33, 34,
]);

/**
 * Computes the check digit for a 10-digit CUIT prefix using Mod-11.
 *
 * Returns `null` when the raw Mod-11 check would be 10 (remainder === 1). A
 * check digit of 10 is not a single digit, so ARCA renumbers such CUITs
 * (prefix 20→23, 27→23, 30→33, 34→33) rather than emitting them. The raw
 * prefix/body combination is therefore INVALID and must never validate — we
 * return `null` instead of fabricating a digit.
 */
export function computeCuitCheckDigit(first10: string): number | null {
  if (!/^\d{10}$/.test(first10)) {
    throw new Error(`Expected 10 numeric digits, got "${first10}"`);
  }
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const weight = CUIT_WEIGHTS[i];
    if (weight === undefined) {
      throw new Error("CUIT weight table is malformed");
    }
    sum += (first10.charCodeAt(i) - 48) * weight;
  }
  const remainder = sum % 11;
  if (remainder === 1) return null;
  const checkDigit = 11 - remainder;
  return checkDigit === 11 ? 0 : checkDigit;
}

/**
 * Validates an 11-digit CUIT: length, type prefix, and Mod-11 check digit.
 * Accepts separators (hyphens/spaces) which are stripped before validation.
 */
export function isValidCuit(cuit: string): boolean {
  const digits = cuit.replace(/[^0-9]/g, "");
  if (digits.length !== 11) return false;
  const prefix = Number(digits.slice(0, 2));
  if (!CUIT_PREFIXES.has(prefix)) return false;
  const lastDigit = digits[10];
  if (lastDigit === undefined) return false;
  const checkDigit = computeCuitCheckDigit(digits.slice(0, 10));
  return checkDigit !== null && checkDigit === Number(lastDigit);
}
