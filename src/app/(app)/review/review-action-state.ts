/**
 * Pure branching logic behind the review row actions.
 *
 * Extracted from `review-actions.tsx` so the actionable/not-actionable states
 * are unit-testable WITHOUT a DOM: a FAILED row offers no approve, a BLOCKED row
 * offers no approve (only reject), a REVIEWED invoice offers approve, etc. The
 * component renders from this discriminated union; the server-side enforcement
 * remains `@/domain/emission` + the approve route — this is the UI hint only.
 */

export interface ReviewActionInput {
  blocked: boolean;
  failed: boolean;
  flagged: boolean;
  invoiceStatus: string;
}

export type ReviewActionState =
  | { kind: "failed" }
  | { kind: "resolve"; blocked: boolean }
  | { kind: "blocked" }
  | { kind: "pending" }
  | { kind: "reviewed" }
  | { kind: "approved" }
  | { kind: "emitted" }
  | { kind: "rejected" }
  | { kind: "other"; status: string };

export function resolveReviewActionState(
  input: ReviewActionInput,
): ReviewActionState {
  if (input.failed) return { kind: "failed" };
  if (input.flagged) return { kind: "resolve", blocked: input.blocked };
  if (input.blocked) return { kind: "blocked" };
  switch (input.invoiceStatus) {
    case "PENDING":
      return { kind: "pending" };
    case "REVIEWED":
      return { kind: "reviewed" };
    case "APPROVED":
    case "EMITTING":
      return { kind: "approved" };
    case "EMITTED":
      return { kind: "emitted" };
    case "REJECTED":
      return { kind: "rejected" };
    default:
      return { kind: "other", status: input.invoiceStatus };
  }
}
