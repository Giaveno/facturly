"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { resolveReviewActionState } from "./review-action-state";

interface ReviewActionsProps {
  rowId: string;
  invoiceId: string;
  status: string;
  invoiceStatus: string;
  blocked: boolean;
  failed: boolean;
  flagged: boolean;
}

async function readError(res: Response): Promise<string> {
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  return json.error ?? "Action failed";
}

/**
 * Per-row review actions. Wires the accountant's operations to the existing
 * server endpoints: confirm (PENDING → REVIEWED), approve (→ APPROVED, triggers
 * the async emit), reject/discard (with a reason), and payer-CUIT resolution for
 * flagged rows. A BLOCKED row offers no approve. Plain — no design work.
 */
export default function ReviewActions(props: ReviewActionsProps) {
  const router = useRouter();
  const [message, setMessage] = useState("");

  async function run(fn: () => Promise<Response>, success: string) {
    setMessage("");
    const res = await fn();
    if (res.ok) {
      setMessage(success);
      router.refresh();
    } else {
      setMessage(await readError(res));
    }
  }

  const approve = () =>
    run(
      () =>
        fetch(`/api/invoices/${props.invoiceId}/approve`, { method: "POST" }),
      "Approved — emission queued",
    );

  const confirm = () =>
    run(
      () =>
        fetch(`/api/invoices/${props.invoiceId}/review`, { method: "POST" }),
      "Confirmed — ready to approve",
    );

  const reject = () => {
    const reason = window.prompt("Discard reason (non-sale transfer, refund, …)");
    if (reason === null) return;
    if (reason.trim() === "") {
      setMessage("A discard reason is required");
      return;
    }
    void run(
      () =>
        fetch(`/api/invoices/${props.invoiceId}/reject`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        }),
      "Discarded",
    );
  };

  async function onResolve(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const cuit = String(data.get("cuit") ?? "");
    await run(
      () =>
        fetch(`/api/rows/${props.rowId}/resolve-payer`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cuit }),
        }),
      "CUIT resolved — row is now approvable",
    );
  }

  const state = resolveReviewActionState(props);

  switch (state.kind) {
    case "failed":
      return <span>Failed — cannot approve</span>;

    case "resolve":
      return (
        <span>
          {state.blocked ? <em>Blocked · </em> : null}
          <form onSubmit={onResolve} style={{ display: "inline" }}>
            <input name="cuit" placeholder="Payer CUIT" required />
            <button type="submit">Resolve CUIT</button>
          </form>
          <button type="button" onClick={reject}>
            Reject
          </button>
          {message ? <span> {message}</span> : null}
        </span>
      );

    case "blocked":
      return (
        <span>
          <button disabled>Blocked — cannot approve</button>
          <button type="button" onClick={reject}>
            Reject
          </button>
          {message ? <span> {message}</span> : null}
        </span>
      );

    case "pending":
      return (
        <span>
          <button type="button" onClick={confirm}>
            Confirm
          </button>
          <button type="button" onClick={reject}>
            Reject
          </button>
          {message ? <span> {message}</span> : null}
        </span>
      );

    case "reviewed":
      return (
        <span>
          <button type="button" onClick={approve}>
            Approve
          </button>
          <button type="button" onClick={reject}>
            Reject
          </button>
          {message ? <span> {message}</span> : null}
        </span>
      );

    case "approved":
      return <span>Approved — emission queued</span>;

    case "emitted":
      return <span>Emitted</span>;

    case "rejected":
      return <span>Discarded</span>;

    default:
      return <span>{state.status}</span>;
  }
}
