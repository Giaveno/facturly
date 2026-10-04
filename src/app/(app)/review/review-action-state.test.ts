import { describe, expect, it } from "vitest";
import { resolveReviewActionState } from "./review-action-state";

/**
 * The branching behind the review row actions. Proves the actionable /
 * not-actionable states WITHOUT a DOM: a FAILED row offers no approve, a
 * BLOCKED row offers no approve (reject only), a REVIEWED invoice offers
 * approve, etc. The server-side enforcement is separate — this locks in the UI
 * hint so a regression hiding `approve` on a FAILED/BLOCKED row fails the suite
 * (W6).
 */
describe("resolveReviewActionState — review row action branching", () => {
  const base = { blocked: false, failed: false, flagged: false, invoiceStatus: "PENDING" };

  it("a FAILED row is not actionable (no approve, no resolve)", () => {
    expect(resolveReviewActionState({ ...base, failed: true })).toEqual({ kind: "failed" });
  });

  it("a BLOCKED row offers no approve (reject only)", () => {
    expect(resolveReviewActionState({ ...base, blocked: true })).toEqual({ kind: "blocked" });
  });

  it("a flagged row offers payer resolution (and tracks the blocked hint)", () => {
    expect(resolveReviewActionState({ ...base, flagged: true })).toEqual({
      kind: "resolve",
      blocked: false,
    });
    expect(resolveReviewActionState({ ...base, flagged: true, blocked: true })).toEqual({
      kind: "resolve",
      blocked: true,
    });
  });

  it("a REVIEWED invoice offers approve", () => {
    expect(resolveReviewActionState({ ...base, invoiceStatus: "REVIEWED" })).toEqual({
      kind: "reviewed",
    });
  });

  it("a PENDING invoice offers confirm (not approve)", () => {
    expect(resolveReviewActionState({ ...base, invoiceStatus: "PENDING" })).toEqual({
      kind: "pending",
    });
  });

  it("APPROVED / EMITTING / EMITTED / REJECTED are non-actionable terminal states", () => {
    expect(resolveReviewActionState({ ...base, invoiceStatus: "APPROVED" })).toEqual({ kind: "approved" });
    expect(resolveReviewActionState({ ...base, invoiceStatus: "EMITTING" })).toEqual({ kind: "approved" });
    expect(resolveReviewActionState({ ...base, invoiceStatus: "EMITTED" })).toEqual({ kind: "emitted" });
    expect(resolveReviewActionState({ ...base, invoiceStatus: "REJECTED" })).toEqual({ kind: "rejected" });
  });

  it("precedence: FAILED beats flagged/blocked; flagged beats blocked", () => {
    expect(resolveReviewActionState({ blocked: true, failed: true, flagged: true, invoiceStatus: "REVIEWED" })).toEqual({ kind: "failed" });
    expect(resolveReviewActionState({ blocked: true, failed: false, flagged: true, invoiceStatus: "REVIEWED" })).toEqual({ kind: "resolve", blocked: true });
  });
});
