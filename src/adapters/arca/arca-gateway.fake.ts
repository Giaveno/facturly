/**
 * Deterministic in-memory ARCA gateway fake. No network, no keys. Two
 * behaviors, both pure:
 *
 *   getIvaCondition — looks up a seeded CUIT→condition map; unknown → "unresolved".
 *   issueInvoice    — assigns sequential cbteNro and a 14-digit CAE from a
 *                     deterministic counter, with a fixed, injectable clock.
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

export class ArcaGatewayFake implements ArcaGateway {
  private readonly conditions: ReadonlyMap<string, CondicionIVA>;
  private readonly clock: Clock;
  private nextCbteNro: number;

  constructor(
    conditions: ReadonlyMap<string, CondicionIVA> = ArcaGatewayFake.DEFAULT_CONDITIONS,
    firstCbteNro = 1,
    clock: Clock = () => new Date(),
  ) {
    this.conditions = conditions;
    this.nextCbteNro = firstCbteNro;
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

  async issueInvoice(req: FECAEReq): Promise<IssueInvoiceResult> {
    // The fake is a deterministic counter; the request content is irrelevant
    // to the issued number/CAE, but the parameter is part of the port contract.
    void req;
    const cbteNro = this.nextCbteNro++;
    return {
      cae: String(CAE_BASE + cbteNro).padStart(14, "0"),
      caeFchVto: this.caeDueDate(),
      cbteNro,
    };
  }

  private caeDueDate(): string {
    // Clone so we never mutate the clock's returned Date.
    const d = new Date(this.clock().getTime());
    d.setUTCDate(d.getUTCDate() + CAE_VALIDITY_DAYS);
    return d.toISOString().slice(0, 10);
  }
}
