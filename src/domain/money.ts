/**
 * Money as integer centavos. No floating-point arithmetic is ever used in the
 * fiscal path — amounts are parsed, stored, and summed as integer centavos.
 */

/** Thrown when an amount string cannot be parsed to integer centavos. */
function invalidAmount(input: string): Error {
  return new Error(`Invalid monetary amount: "${input}"`);
}

/**
 * Parses a decimal amount string ("1234.56", "0.10", "1") into integer
 * centavos. Uses string math only — no parseFloat, no floating point.
 *
 * Accepts up to two decimal places. Rejects negatives and malformed input.
 */
export function parseToCentavos(input: string): number {
  const trimmed = input.trim();
  // Plain decimal only ("1234.56", "0.10", "1"). Thousands separators and the
  // reversed "1.234,56" convention are rejected. Negatives (credit notes) are
  // out of scope for v1.
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw invalidAmount(input);
  }
  const dotIndex = trimmed.indexOf(".");
  const whole = dotIndex === -1 ? trimmed : trimmed.slice(0, dotIndex);
  const frac = dotIndex === -1 ? "" : trimmed.slice(dotIndex + 1);
  const wholeCents = parseInt(whole, 10) * 100;
  const fracCents = parseInt((frac + "00").slice(0, 2), 10);
  const result = wholeCents + fracCents;
  if (!Number.isSafeInteger(result)) {
    throw invalidAmount(input);
  }
  return result;
}

/**
 * Formats integer centavos back to a decimal string ("123456" -> "1234.56").
 */
export function formatCentavos(cents: number): string {
  if (!Number.isInteger(cents)) {
    throw new Error(`Expected integer centavos, got ${cents}`);
  }
  if (cents < 0) {
    throw new Error(`Amount cannot be negative: ${cents}`);
  }
  const whole = Math.floor(cents / 100);
  const frac = String(cents % 100).padStart(2, "0");
  return `${whole}.${frac}`;
}

/**
 * Sums integer centavos. Integer-only arithmetic (exact up to 2^53), so
 * fractional accumulation never drifts.
 */
export function sumCentavos(...cents: number[]): number {
  let total = 0;
  for (const c of cents) {
    if (!Number.isSafeInteger(c)) {
      throw new Error(`Expected a safe integer number of centavos, got ${c}`);
    }
    if (c < 0) {
      throw new Error(`Amount cannot be negative: ${c}`);
    }
    total += c;
    if (!Number.isSafeInteger(total)) {
      throw new Error(`Sum exceeds the safe-integer range: ${total}`);
    }
  }
  return total;
}
