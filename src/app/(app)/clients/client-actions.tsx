"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

interface ClientActionsProps {
  clientId: string;
  razonSocial: string;
  cuit: string;
  ptoVta: number;
  condicionIva: string;
  delegationEnabled: boolean;
}

const CONDICIONES: Array<[string, string]> = [
  ["ri", "Responsable Inscripto"],
  ["monotributista", "Monotributista"],
  ["exento", "Exento"],
];

/**
 * Per-client actions: toggle the `wsfe` delegation and edit the client's fields.
 * Both POST/PATCH to the server endpoints and refresh on success. Plain.
 */
export default function ClientActions(props: ClientActionsProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState("");

  async function toggleDelegation() {
    setMessage("");
    const res = await fetch(`/api/clients/${props.clientId}/delegation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !props.delegationEnabled }),
    });
    if (!res.ok) {
      setMessage("Failed to update delegation");
      return;
    }
    router.refresh();
  }

  async function onEdit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMessage("");
    const data = new FormData(e.currentTarget);
    const payload = {
      razonSocial: String(data.get("razonSocial") ?? ""),
      cuit: String(data.get("cuit") ?? ""),
      ptoVta: Number(data.get("ptoVta") ?? "0"),
      condicionIva: String(data.get("condicionIva") ?? "ri"),
    };
    const res = await fetch(`/api/clients/${props.clientId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const json = (await res.json()) as { error?: string };
      setMessage(json.error ?? "Failed to update client");
      return;
    }
    setEditing(false);
    router.refresh();
  }

  return (
    <span>
      <button type="button" onClick={toggleDelegation}>
        {props.delegationEnabled ? "Disable wsfe" : "Enable wsfe"}
      </button>{" "}
      <button type="button" onClick={() => setEditing((v) => !v)}>
        {editing ? "Cancel" : "Edit"}
      </button>
      {editing ? (
        <form onSubmit={onEdit}>
          <input name="razonSocial" defaultValue={props.razonSocial} required />
          <input name="cuit" defaultValue={props.cuit} required />
          <input name="ptoVta" type="number" min={1} max={9999} defaultValue={props.ptoVta} required />
          <select name="condicionIva" defaultValue={props.condicionIva}>
            {CONDICIONES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <button type="submit">Save</button>
        </form>
      ) : null}
      {message ? <span> {message}</span> : null}
    </span>
  );
}
