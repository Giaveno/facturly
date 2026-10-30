/**
 * Port: ArcaGateway — the ARCA (WSAA / WSFEv1) boundary.
 *
 * Production adapters (slice 3) speak PKCS#7 LoginCms + SOAP WSFEv1. The fake
 * (slice 2) is deterministic and offline. Both satisfy this contract.
 */

import type { CbteTipo, CondicionIVA } from "@/domain/policy";
import type { Centavos } from "@/domain/money";

/** WSFEv1 `FECAESolicitar` request — the minimal field set the gateway needs. */
export interface FECAEReq {
  /** Emisor CUIT (the delegated client CUIT). */
  cuit: string;
  /** Punto de venta. */
  ptoVta: number;
  /** Comprobante tipo (1|6|11 — see policy.ts). */
  cbteTipo: CbteTipo;
  /**
   * The INTENDED comprobante number (CbteDesde = CbteHasta). The caller pins
   * this (from a persisted reservation); the gateway does NOT derive it from
   * FECompUltimoAutorizado. Existing reservations are consulted, never reissued.
   */
  cbteNro: number;
  /** Receptor document type (80 CUIT, 99 consumidor final). */
  receptorDocTipo: number;
  /** Receptor document number. */
  receptorDocNro: number;
  /**
   * WSFEv1 `CondicionIVAReceptorId` (RG 5616): 1 RI, 4 Exento, 5 CF, 6
   * Monotributista. SEPARATE from `receptorDocTipo` — this is the receptor's
   * IVA condition, not their document type. Mandatory since 2026-09-01.
   */
  condicionIvaReceptorId: number;
  /** Receptor legal name. */
  receptorRazonSocial: string;
  /** Emission date (CbteFch), YYYY-MM-DD. */
  fechaEmision: string;
  /** Due date (FchVtoPago), YYYY-MM-DD. */
  fechaVto: string;
  /** 3-char currency code, e.g. "PES". */
  moneda: string;
  /** Exchange rate (1 when moneda is PES). */
  cotizacion: number;
  /** Net amount in integer centavos. */
  importeNeto: Centavos;
  /** IVA amount in integer centavos. */
  importeIva: Centavos;
  /** Total amount in integer centavos. */
  importeTotal: Centavos;
  /** Explicit single taxable rate; mandatory for newly approved A/B. */
  taxRate?: number | null;
  /** Original invoice referenced by a credit note (WSFEv1 CbtesAsoc). */
  cbtesAsoc?: Array<{ tipo: number; ptoVta: number; nro: number }>;
}

/** Successful emission result. */
export interface IssueInvoiceResult {
  /** 14-digit CAE. */
  cae: string;
  /** CAE expiry date (YYYY-MM-DD). */
  caeFchVto: string;
  /** Comprobante number assigned by ARCA. */
  cbteNro: number;
}

export interface ArcaGateway {
  /**
   * Padrón A5 → normalized IVA condition, or "unresolved" when the person is
   * genuinely absent from the Padrón. A lookup ERROR throws (never downgrades
   * to Consumidor Final). `clientCuit` is the delegating client CUIT
   * (cuitRepresentada); `payerCuit` is the CUIT being looked up (idPersona).
   */
  getIvaCondition(
    clientCuit: string,
    payerCuit: string,
  ): Promise<CondicionIVA | "unresolved">;
  /** Revalidate ownership after authentication/building. onDispatched MUST run immediately before the issuance HTTP call, never on login/build failure. */
  issueInvoice(r: FECAEReq, beforeDispatch?: () => Promise<void>, onDispatched?: () => void): Promise<IssueInvoiceResult>;
  /** Read-only lookup that returns a result only after exact fiscal comparison. */
  consultInvoice?(r: FECAEReq): Promise<IssueInvoiceResult | null>;
  /**
   * The LAST authorized comprobante number for `(cuit, ptoVta, cbteTipo)`
   * (WSFEv1 `FECompUltimoAutorizado`). Every fresh reservation uses validated
   * remote last+1 under its durable series claim. An explicit returned 0 means
   * the next comprobante is 1; missing values and provider errors are not zero.
   */
  ultimoAutorizado(
    cuit: string,
    ptoVta: number,
    cbteTipo: CbteTipo,
  ): Promise<number>;
}
