/**
 * XML safety for SOAP envelope builders.
 *
 * SOAP bodies are assembled by string interpolation. Any free-form value
 * (currency code, payer CUIT, etc.) interpolated raw into XML is an injection
 * hazard. This module provides `escapeXml` (apply at the boundary) and
 * `validateMonId` (currency-code allow-list), both used by the WSFEv1 and
 * Padrón A5 envelope builders.
 */

/**
 * Escapes the five XML-special characters. Apply to ANY interpolated string
 * that is not already known-safe (base64, digits, ARCA-formatted dates).
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * ARCA's `MonId` is a currency code (e.g. "PES", "DOL") — three letters. Anything
 * else is rejected before it reaches the SOAP body (allow-list).
 */
export function validateMonId(monId: string): string {
  if (!/^[A-Za-z]{3}$/.test(monId)) {
    throw new Error(`Invalid MonId "${monId}" — expected a 3-letter currency code`);
  }
  return monId;
}
