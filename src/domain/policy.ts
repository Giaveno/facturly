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

/**
 * WSFEv1 receptor DOCUMENT TYPES (`DocTipo`). A receptor identified by a CUIT
 * is `80`; a Consumidor Final (no CUIT) is `99` with `DocNro = 0`. These are
 * SEPARATE from the IVA-condition id (`CondicionIVAReceptorId`, RG 5616).
 */
export const RECEPTOR_DOC_TIPO_CUIT = 80;
export const RECEPTOR_DOC_TIPO_CONSUMIDOR_FINAL = 99;

/**
 * The WSFEv1 `CondicionIVAReceptorId` (RG 5616) value for Monotributista. Used
 * by `requiresLey27618Legend` — the ONLY receptor whose Factura A must carry
 * the legend. (Full mapping lives at `condicionIvaToReceptorId` in the padron
 * adapter: 1 RI, 4 Exento, 5 CF, 6 Monotributista.)
 */
export const RECEPTOR_IVA_MONOTRIBUTISTA = 6;

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
 * Legacy presentation distinction only. NEVER use this predicate to derive
 * WSFE amounts: taxable A AND B require net/IVA and alicuotas. C has no IVA.
 * Fiscal-transparency presentation requirements are a separate concern.
 */
export function discriminatesIva(cbteTipo: CbteTipo): boolean {
  return cbteTipo === FACTURA_A;
}

/**
 * The Ley 27.618 legend appears ONLY on a Factura A issued to a Monotributista
 * receptor. `cbteTipo === 1` already implies an RI emisor (only RI emits
 * Factura A), so this single predicate identifies the RI → Monotributista cell.
 *
 * It keys off the receptor's IVA condition (`CondicionIVAReceptorId === 6`),
 * NOT the document type (`DocTipo`) — a Monotributista is identified by their
 * CUIT (DocTipo 80) but their *condition* is 6.
 */
export function requiresLey27618Legend(
  cbteTipo: CbteTipo,
  condicionIvaReceptorId: number,
): boolean {
  return cbteTipo === FACTURA_A && condicionIvaReceptorId === RECEPTOR_IVA_MONOTRIBUTISTA;
}
