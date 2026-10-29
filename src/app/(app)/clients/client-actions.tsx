"use client";

import React, { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import PointsOfSaleAction from "./points-of-sale-action";

interface ClientActionsProps {
  clientId: string;
  razonSocial: string;
  cuit: string;
  ptoVta: number;
  condicionIva: string;
  delegationEnabled: boolean;
  fingerprint: string | null;
  homologationEnabled: boolean;
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
  const [verificationVersion, setVerificationVersion] = useState(0);

  async function toggleDelegation() {
    setVerificationVersion(v => v + 1);
    setMessage("");
    const res = await fetch(`/api/clients/${props.clientId}/delegation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !props.delegationEnabled }),
    });
    if (!res.ok) {
      setMessage("No se pudo actualizar la delegación.");
      return;
    }
    router.refresh();
  }

  async function onEdit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setVerificationVersion(v => v + 1);
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
      setMessage(json.error ?? "No se pudo actualizar el cliente.");
      return;
    }
    setEditing(false);
    router.refresh();
  }

  return (
    <div>
      <button type="button" onClick={toggleDelegation}>
        {props.delegationEnabled ? "Desactivar delegación" : "Registrar delegación"}
      </button>{" "}
      <button type="button" onClick={() => { setVerificationVersion(v => v + 1); setEditing(v => !v); }}>
        {editing ? "Cancelar" : "Editar"}
      </button>
      {editing ? (
        <form onSubmit={onEdit} onChange={() => setVerificationVersion(v => v + 1)}>
          <input name="razonSocial" defaultValue={props.razonSocial} required />
          <input name="cuit" defaultValue={props.cuit} required />
          <input name="ptoVta" type="number" min={1} max={99998} defaultValue={props.ptoVta} required />
          <select name="condicionIva" defaultValue={props.condicionIva}>
            {CONDICIONES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <button type="submit">Guardar cambios</button>
        </form>
      ) : null}
      {message ? <span role="status"> {message}</span> : null}
      <PointsOfSaleAction
        key={JSON.stringify([props, verificationVersion])}
        client={{ id: props.clientId, cuit: props.cuit, ptoVta: props.ptoVta, razonSocial: props.razonSocial, condicionIva: props.condicionIva }}
        fingerprint={props.fingerprint}
        enabled={props.homologationEnabled}
        editing={editing}
      />
    </div>
  );
}
