/**
 * Homologación gate decision logic — the pre-apply criterion that validates the
 * whole delegation model.
 *
 * Criterion (design #12):
 *   `FECAESolicitar` with `Auth.Cuit = <client CUIT>` returns `Resultado = A`,
 *   using ONE TA obtained with the accountant's certificate.
 *
 * PASS  → the one-TA delegation model holds (the accountant's cert + per-client
 *         wsfe delegation is enough).
 * FAIL  → fall back to the per-client WSAA TA model (one TA per client CUIT).
 *
 * This module is pure so the decision is unit-tested OFFLINE; the actual ARCA
 * call requires a real certificate and network, so it lives in a manual harness
 * (`scripts/homologacion-spike.ts`) — NOT a CI test.
 */

import type { FecaesolicitarResult } from "./wsfe";

export const HOMOLOGACION_CRITERION =
  "FECAESolicitar with Auth.Cuit=<client CUIT> returns Resultado=A using one accountant-certificate TA";

export interface HomologacionVerdict {
  passed: boolean;
  criterion: string;
  detail: string;
}

/**
 * Evaluates a parsed `FECAESolicitar` result against the homologación criterion.
 * A `Resultado` of "A" WITH a 14-digit CAE passes; anything else fails.
 */
export function evaluateEmissionResult(
  result: FecaesolicitarResult,
): HomologacionVerdict {
  const passed = result.resultado === "A" && result.cae !== null;

  if (passed) {
    return {
      passed: true,
      criterion: HOMOLOGACION_CRITERION,
      detail: `Resultado=A, CAE=${result.cae} — one-TA delegation model CONFIRMED.`,
    };
  }

  const codes = result.errors.map((e) => e.code).join(", ");
  const msgs = result.errors.map((e) => e.msg).filter(Boolean).join("; ");
  const obs = result.observaciones.map((o) => o.code).join(", ");
  return {
    passed: false,
    criterion: HOMOLOGACION_CRITERION,
    detail:
      `Resultado=${result.resultado} (expected A)` +
      (codes ? `, errors=[${codes}]` : "") +
      (msgs ? `, messages=[${msgs}]` : "") +
      (obs ? `, observaciones=[${obs}]` : "") +
      ` — fall back to the per-client WSAA TA model.`,
  };
}
