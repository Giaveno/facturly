"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

const CONDICIONES: Array<[string, string]> = [
  ["ri", "Responsable Inscripto"],
  ["monotributista", "Monotributista"],
  ["exento", "Exento"],
];

/**
 * New-client form. POSTs to /api/clients and refreshes on success. The
 * accountant may opt to create the client's `wsfe` delegation at the same time.
 */
export default function ClientsForm() {
  const router = useRouter();
  const [feedback, setFeedback] = useState<string>("");
  const [error, setError] = useState<string>("");

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFeedback("");
    setError("");
    const form = e.currentTarget;
    const data = new FormData(form);
    const payload = {
      razonSocial: String(data.get("razonSocial") ?? ""),
      cuit: String(data.get("cuit") ?? ""),
      ptoVta: Number(data.get("ptoVta") ?? "0"),
      condicionIva: String(data.get("condicionIva") ?? "ri"),
      createDelegation: data.get("createDelegation") === "on",
    };

    const res = await fetch("/api/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = (await res.json()) as { error?: string };
    if (res.ok) {
      form.reset();
      setFeedback("Client created.");
      router.refresh();
    } else {
      setError(json.error ?? "Failed to create client");
    }
  }

  return (
    <form onSubmit={onSubmit}>
      <label>
        Razón social
        <input name="razonSocial" required />
      </label>
      <label>
        CUIT
        <input name="cuit" required />
      </label>
      <label>
        Punto de venta
        <input name="ptoVta" type="number" min={1} max={9999} required />
      </label>
      <label>
        Condición IVA
        <select name="condicionIva">
          {CONDICIONES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <input name="createDelegation" type="checkbox" defaultChecked />
        Create wsfe delegation
      </label>
      <button type="submit">Create client</button>
      {feedback ? <p>{feedback}</p> : null}
      {error ? <p>{error}</p> : null}
    </form>
  );
}
