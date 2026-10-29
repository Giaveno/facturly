"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";

type UploadClient = { id: string; razonSocial: string; cuit: string };

/**
 * Minimal upload form (skeleton). Selects a client and one-or-more photos,
 * POSTs them to /api/upload, and shows the persisted row statuses.
 */
export default function UploadForm({ clients }: { clients: UploadClient[] }) {
  const [clientId, setClientId] = useState(clients.length === 1 ? clients[0]?.id ?? "" : "");
  const [feedback, setFeedback] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setFeedback("Cargando comprobantes…");
    const form = e.currentTarget;
    try {
      const data = new FormData(form);
      const res = await fetch("/api/upload", { method: "POST", body: data });
      const json = (await res.json().catch(() => ({}))) as { error?: string; rows?: unknown[] };
      setFeedback(res.ok
        ? `Carga recibida. Se registraron ${json.rows?.length ?? 0} comprobante(s) para procesar.`
        : json.error ?? "No se pudo completar la carga. Revisá los archivos e intentá nuevamente.");
      if (res.ok) form.reset();
    } catch {
      setFeedback("No se pudo conectar con el servicio. Revisá tu conexión e intentá nuevamente.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="surface upload-form form-stack" onSubmit={onSubmit}>
      {clients.length ? <label>
        Empresa emisora
        <select name="clientId" value={clientId} onChange={(e) => setClientId(e.target.value)} required>
          <option value="" disabled>Seleccioná una empresa</option>
          {clients.map((client) => <option key={client.id} value={client.id}>{client.razonSocial} · CUIT {client.cuit}</option>)}
        </select>
      </label> : <div className="empty-state"><strong>Primero necesitás registrar una empresa emisora.</strong><p>Después vas a poder asociar cada carga a un cliente real.</p><Link className="button" href="/clients">Ir a Clientes</Link></div>}
      <label>
        Fotos de comprobantes
        <input name="photos" type="file" accept="image/jpeg,image/png,image/webp" multiple required />
      </label>
      <p className="helper-note">El OCR con Gemini solo se activa explícitamente en el servidor. Si lo habilitás, usá únicamente comprobantes sintéticos o completamente anonimizados: las imágenes se envían a Google y el nivel de privacidad y las cuotas dependen de tu proyecto de AI Studio.</p>
      <button type="submit" disabled={!clients.length || !clientId || submitting}>{submitting ? "Cargando…" : "Cargar comprobantes"}</button>
      {feedback ? <p className="feedback" role="status">{feedback}</p> : null}
    </form>
  );
}
