/**
 * Deterministic in-memory ARCA gateway fake. No network, no keys.
 *
 *   getIvaCondition  — looks up a seeded CUIT→condition map; unknown → "unresolved".
 *   issueInvoice     — honors the CALLER-PINNED `req.cbteNro` (slice-3 port
 *                      amendment) and returns a 14-digit CAE from a deterministic
 *                      formula. A second call with the SAME `(cuit, ptoVta,
 *                      cbteTipo, cbteNro)` returns the SAME prior CAE — the fake
 *                      models ARCA's 10015/10016 duplicate + FECompConsultar
 *                      recovery as "return the already-issued CAE".
 *   ultimoAutorizado — the last issued comprobante number per key (0 = none).
 *
 * Determinism: `issueInvoice` derives `caeFchVto` from an injected clock (a
 * function returning a `Date`). The default is the real clock; tests inject a
 * fixed date and assert an EXACT due date.
 */

import type {
  ArcaGateway,
  FECAEReq,
  IssueInvoiceResult,
} from "@/ports/arca-gateway";
import type { CondicionIVA } from "@/domain/policy";

/**
 * The 14-digit CAE space ARCA issues from. The fake fills the 14-digit CAE with
 * `CAE_BASE + cbteNro`, left-padded to 14 digits.
 */
export const CAE_BASE = 70_000_000_000_000;

/**
 * A CAE is valid for 10 calendar days from its emission date (AFIP rule). The
 * fake mirrors this so offline emissions carry a realistic expiry.
 */
export const CAE_VALIDITY_DAYS = 10;

/** A clock returning the current instant. Injectable for determinism. */
export type Clock = () => Date;

function key(cuit: string, ptoVta: number, cbteTipo: number): string {
  return `${cuit}:${ptoVta}:${cbteTipo}`;
}

export class ArcaGatewayFake implements ArcaGateway {
  private readonly conditions: ReadonlyMap<string, CondicionIVA>;
  private readonly clock: Clock;
  /** Last authorized comprobante number per (cuit, ptoVta, cbteTipo). */
  private readonly lastAuthorized = new Map<string, number>();
  /** Issued CAEs per (cuit, ptoVta, cbteTipo, cbteNro) — powers duplicate recovery. */
  private readonly issued = new Map<string, IssueInvoiceResult>();

  constructor(
    conditions: ReadonlyMap<string, CondicionIVA> = ArcaGatewayFake.DEFAULT_CONDITIONS,
    clock: Clock = () => new Date(),
  ) {
    this.conditions = conditions;
    this.clock = clock;
  }

  static readonly DEFAULT_CONDITIONS: ReadonlyMap<string, CondicionIVA> = new Map(
    [
      ["20123456786", "ri"],
      ["30710145764", "monotributista"],
      ["30717336905", "exento"],
    ],
  );

  async getIvaCondition(
    _clientCuit: string,
    payerCuit: string,
  ): Promise<CondicionIVA | "unresolved"> {
    return this.conditions.get(payerCuit) ?? "unresolved";
  }

  async ultimoAutorizado(
    cuit: string,
    ptoVta: number,
    cbteTipo: number,
  ): Promise<number> {
    return this.lastAuthorized.get(key(cuit, ptoVta, cbteTipo)) ?? 0;
  }

  async issueInvoice(req: FECAEReq): Promise<IssueInvoiceResult> {
    // The fake honors the CALLER-PINNED number (the port contract since slice 3).
    const cbteNro = req.cbteNro;
    const duplicateKey = `${key(req.cuit, req.ptoVta, req.cbteTipo)}:${cbteNro}`;

    // Duplicate recovery: an already-issued number returns the SAME prior CAE
    // (models ARCA 10015/10016 → FECompConsultar).
    const prior = this.issued.get(duplicateKey);
    if (prior) return prior;

    const result: IssueInvoiceResult = {
      cae: String(CAE_BASE + cbteNro).padStart(14, "0"),
      caeFchVto: this.caeDueDate(),
      cbteNro,
    };
    this.issued.set(duplicateKey, result);
    const sk = key(req.cuit, req.ptoVta, req.cbteTipo);
    this.lastAuthorized.set(
      sk,
      Math.max(this.lastAuthorized.get(sk) ?? 0, cbteNro),
    );
    return result;
  }

  private caeDueDate(): string {
    // Clone so we never mutate the clock's returned Date.
    const d = new Date(this.clock().getTime());
    d.setUTCDate(d.getUTCDate() + CAE_VALIDITY_DAYS);
    return d.toISOString().slice(0, 10);
  }
}
