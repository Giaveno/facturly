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
  return json.error ?? "No se pudo completar la acción.";
}

/**
 * Per-row review actions. Wires the accountant's operations to the existing
 * server endpoints: confirm (PENDING → REVIEWED), approve (→ APPROVED, triggers
 * the async emit), reject/discard (with a reason), and payer-CUIT resolution for
 * flagged rows. A BLOCKED row offers no approval.
 */
export default function ReviewActions(props: ReviewActionsProps) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<Response>, success: string) {
    setMessage("");
    setBusy(true);
    try {
      const res = await fn();
      if (res.ok) {
        setMessage(success);
        router.refresh();
      } else {
        setMessage(await readError(res));
      }
    } catch {
      setMessage("No se pudo conectar con el servicio. Intentá nuevamente.");
    } finally {
      setBusy(false);
    }
  }

  const approve = () =>
    window.confirm("Al aprobar, se iniciará el proceso de emisión del comprobante en ARCA. ¿Querés continuar?") &&
    run(
      () =>
        fetch(`/api/invoices/${props.invoiceId}/approve`, { method: "POST" }),
      "Aprobada. Se inició el proceso de emisión; el estado final puede tardar en actualizarse.",
    );

  const confirm = () =>
    run(
      () =>
        fetch(`/api/invoices/${props.invoiceId}/review`, { method: "POST" }),
      "Revisión confirmada. Ya podés aprobar el comprobante.",
    );

  const reject = () => {
    const reason = window.prompt("Motivo del rechazo (por ejemplo, transferencia no comercial o devolución)");
    if (reason === null) return;
    if (reason.trim() === "") {
      setMessage("Indicá un motivo para rechazar el comprobante.");
      return;
    }
    void run(
      () =>
        fetch(`/api/invoices/${props.invoiceId}/reject`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        }),
      "Comprobante rechazado.",
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
      "CUIT resuelto. Actualizando el estado del comprobante.",
    );
  }

  const state = resolveReviewActionState(props);

  switch (state.kind) {
    case "failed":
      return <span role="status">Falló el procesamiento; no se puede aprobar.</span>;

    case "resolve":
      return (
        <span>
          {state.blocked ? <em>Blocked · </em> : null}
          <form onSubmit={onResolve}>
            <label>CUIT del pagador<input name="cuit" placeholder="CUIT" inputMode="numeric" required /></label>
            <button type="submit" disabled={busy}>Resolver CUIT</button>
          </form>
          <button type="button" onClick={reject} disabled={busy}>
            Rechazar
          </button>
          {message ? <span role="status">{message}</span> : null}
        </span>
      );

    case "blocked":
      return (
        <span>
          <button disabled>Bloqueada: no se puede aprobar</button>
          <button type="button" onClick={reject} disabled={busy}>
            Rechazar
          </button>
          {message ? <span role="status">{message}</span> : null}
        </span>
      );

    case "pending":
      return (
        <span>
          <button type="button" onClick={confirm} disabled={busy}>
            Confirmar revisión
          </button>
          <button type="button" onClick={reject} disabled={busy}>
            Rechazar
          </button>
          {message ? <span role="status">{message}</span> : null}
        </span>
      );

    case "reviewed":
      return (
        <span>
          <button type="button" onClick={approve} disabled={busy}>
            Aprobar y emitir
          </button>
          <button type="button" onClick={reject} disabled={busy}>
            Rechazar
          </button>
          {message ? <span role="status">{message}</span> : null}
        </span>
      );

    case "approved":
      return <span>Aprobada; emisión en proceso</span>;

    case "emitted":
      return <span>Emitida</span>;

    case "rejected":
      return <span>Rechazada</span>;

    default:
      return <span>{state.status}</span>;
  }
}
