/**
 * Invoice type policy — the pure A/B/C decision.
 *
 * The matrix is fixed by law (RG 5003 / Ley 27.618 effective since 07/2021):
 *
 *   Emisor \ Receptor          | CF / Exento | Monotributista | Resp. Inscripto
 *   ---------------------------+-------------+----------------+-----------------
 *   Responsable Inscripto      | B(6)        | A(1) + legend  | A(1)
 *   Monotributista / Exento    | C(11)       | C(11)          | C(11)
 *
 * The critical (and commonly mis-implemented) cell: RI → Monotributista is
 * Factura A(1) WITH the Ley 27.618 legend — NOT B, NOT C.
 *
 * Export (E/19) is OUT of scope; this function can never produce it.
 */

export type CondicionIVA =
  | "ri"
  | "monotributista"
  | "exento"
  | "consumidorFinal";

export type CbteTipo = 1 | 6 | 11;

export interface CbteTipoDecision {
  cbteTipo: CbteTipo;
  requiresLey27618Legend: boolean;
}

type Emisor = Exclude<CondicionIVA, "consumidorFinal">;

const FACTURA_A: CbteTipo = 1;
const FACTURA_B: CbteTipo = 6;
const FACTURA_C: CbteTipo = 11;

const MATRIX: Record<Emisor, Record<CondicionIVA, CbteTipoDecision>> = {
  ri: {
    ri: { cbteTipo: FACTURA_A, requiresLey27618Legend: false },
    // Ley 27.618 (07/2021) / RG 5003: RI → Monotributista = A with legend.
    monotributista: { cbteTipo: FACTURA_A, requiresLey27618Legend: true },
    exento: { cbteTipo: FACTURA_B, requiresLey27618Legend: false },
    consumidorFinal: { cbteTipo: FACTURA_B, requiresLey27618Legend: false },
  },
  monotributista: {
    ri: { cbteTipo: FACTURA_C, requiresLey27618Legend: false },
    monotributista: { cbteTipo: FACTURA_C, requiresLey27618Legend: false },
    exento: { cbteTipo: FACTURA_C, requiresLey27618Legend: false },
    consumidorFinal: { cbteTipo: FACTURA_C, requiresLey27618Legend: false },
  },
  exento: {
    ri: { cbteTipo: FACTURA_C, requiresLey27618Legend: false },
    monotributista: { cbteTipo: FACTURA_C, requiresLey27618Legend: false },
    exento: { cbteTipo: FACTURA_C, requiresLey27618Legend: false },
    consumidorFinal: { cbteTipo: FACTURA_C, requiresLey27618Legend: false },
  },
};

// Deep-freeze the matrix so a caller cannot corrupt the shared table through a
// reference to one of its cells (the cells are objects, not primitives).
for (const row of Object.values(MATRIX)) {
  Object.freeze(row);
}
Object.freeze(MATRIX);

export function cbteTipo(
  emisor: CondicionIVA,
  receptor: CondicionIVA,
): CbteTipoDecision {
  if (emisor === "consumidorFinal") {
    throw new Error("Consumidor Final cannot be an invoice emisor");
  }
  const cell = MATRIX[emisor][receptor];
  if (cell === undefined) {
    throw new Error(
      `Unresolved comprobante type for emisor "${emisor}", receptor "${receptor}"`,
    );
  }
  // Return a copy so callers cannot mutate the shared matrix.
  return { ...cell };
}

/**
 * IVA discrimination follows the comprobante type by law, NOT a configurable
 * flag. Only Factura A discriminates IVA (itemized alícuotas); B and C are
 * priced gross with IVA included and no breakdown.
 */
export function discriminatesIva(cbteTipo: CbteTipo): boolean {
  return cbteTipo === FACTURA_A;
}
