"use client";

import { useState, type FormEvent } from "react";

type Environment = "homologacion" | "production";
type Item = { descripcion: string; neto: string; alicuota: string };

interface FiscalError { code?: string | number; message?: string }

export function interpretEmissionResponse(data: Record<string, unknown>): { kind: "success" | "rejected" | "blocked"; text: string; retryAllowed: boolean } {
  const errors = Array.isArray(data.errors) ? data.errors : data.code ? [{ code: data.code, message: data.message ?? data.error }] : [];
  const detail = errors.map((error: FiscalError) => `${error.code ?? "ARCA"}: ${error.message ?? "Error fiscal"}`).join(" · ");
  const storedError = typeof data.errores === "string" ? data.errores : "";
  const text = detail || storedError || (typeof data.error === "string" ? data.error : "") || (typeof data.message === "string" ? data.message : "") || "No se pudo emitir el comprobante.";
  if (data.estado === "aprobado") return { kind: "success", text: `Comprobante emitido${data.cae ? ` · CAE ${data.cae}` : ""}.`, retryAllowed: true };
  const blocked = data.estado === "incierto" || data.code === "SERIES_BLOCKED" || data.status === "incierto" || /serie bloqueada|incierto|conciliaci/i.test(String(text));
  return { kind: blocked ? "blocked" : "rejected", text: blocked ? `${text} No reintentes a ciegas: verificá la serie antes de continuar.` : text, retryAllowed: !blocked };
}

function newKey() {
  return crypto.randomUUID();
}

interface Company { id: string; razonSocial: string; cuit: string }

export default function EmissionForm({ environment, companies }: { environment: Environment; companies: Company[] }) {
  const [idempotencyKey, setIdempotencyKey] = useState(newKey);
  const [item, setItem] = useState<Item>({ descripcion: "", neto: "", alicuota: "21" });
  const [form, setForm] = useState({ empresaId: "", cbteTipo: "1", ptoVta: "1", concepto: "1", docTipo: "99", docNro: "0", condicionIvaReceptor: "5", fecha: new Date().toISOString().slice(0, 10) });
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [retryAllowed, setRetryAllowed] = useState(true);

  const update = (name: string, value: string) => setForm((current) => ({ ...current, [name]: value }));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !retryAllowed) return;
    setBusy(true);
    setFeedback(null);
    try {
      const netoCentavos = Math.round(Number(item.neto || 0) * 100);
      const alicuota = Number(item.alicuota);
      const ivaCentavos = Math.round(netoCentavos * alicuota / 100);
      const result = await fetch("/api/comprobantes", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ ...form, ambiente: environment, idempotencyKey, cbteTipo: Number(form.cbteTipo), ptoVta: Number(form.ptoVta), concepto: Number(form.concepto), docTipo: Number(form.docTipo), condicionIvaReceptor: Number(form.condicionIvaReceptor), importeNetoCentavos: netoCentavos, importeIvaCentavos: ivaCentavos, importeExentoCentavos: 0, importeTributosCentavos: 0, importeTotalCentavos: netoCentavos + ivaCentavos, items: [{ descripcion: item.descripcion, netoCentavos, ivaCentavos, exentoCentavos: 0, tributosCentavos: 0, totalCentavos: netoCentavos + ivaCentavos, alicuota }] }),
      });
      const data = await result.json().catch(() => ({}));
      const interpreted = interpretEmissionResponse(data);
      if (!result.ok || interpreted.kind !== "success") {
        setRetryAllowed(interpreted.retryAllowed);
        setFeedback({ kind: "error", text: interpreted.text });
        return;
      }
      setFeedback({ kind: "success", text: interpreted.text });
      setIdempotencyKey(newKey());
      setRetryAllowed(true);
    } catch {
      setFeedback({ kind: "error", text: "No se pudo conectar con el servicio. La clave se conserva para reintentar de forma segura." });
    } finally {
      setBusy(false);
    }
  }

  return <form className="surface form-stack" onSubmit={submit} aria-label="Formulario de emisión">
    <p className="helper-note">Clave de idempotencia: <code>{idempotencyKey}</code>. Se reutiliza durante los reintentos de esta emisión.</p>
    <div className="form-grid">
      <label>Empresa emisora<select name="empresaId" required value={form.empresaId} onChange={(e) => update("empresaId", e.target.value)}><option value="">Seleccioná una empresa</option>{companies.map((company) => <option key={company.id} value={company.id}>{company.razonSocial} · CUIT {company.cuit}</option>)}</select></label>
      <label>CUIT emisor<input name="emisorCuit" inputMode="numeric" readOnly value={companies.find((company) => company.id === form.empresaId)?.cuit ?? ""} aria-readonly="true" /></label>
      <label>Tipo<select name="cbteTipo" value={form.cbteTipo} onChange={(e) => update("cbteTipo", e.target.value)}><option value="1">Factura A</option><option value="6">Factura B</option><option value="11">Factura C</option></select></label>
      <label>Concepto<select name="concepto" value={form.concepto} onChange={(e) => update("concepto", e.target.value)}><option value="1">Productos</option><option value="2">Servicios</option><option value="3">Productos y servicios</option></select></label>
      <label>Punto de venta<input name="ptoVta" type="number" min="1" required value={form.ptoVta} onChange={(e) => update("ptoVta", e.target.value)} /></label>
      <label>Fecha<input name="fecha" type="date" required value={form.fecha} onChange={(e) => update("fecha", e.target.value)} /></label>
    </div>
    <fieldset><legend>Destinatario</legend><div className="form-grid"><label>Tipo de documento<input name="docTipo" inputMode="numeric" required value={form.docTipo} onChange={(e) => update("docTipo", e.target.value)} /></label><label>Número<input name="docNro" required value={form.docNro} onChange={(e) => update("docNro", e.target.value)} /></label><label>Condición IVA<input name="condicionIvaReceptor" inputMode="numeric" required value={form.condicionIvaReceptor} onChange={(e) => update("condicionIvaReceptor", e.target.value)} /></label></div></fieldset>
    <fieldset><legend>Ítems e IVA</legend><div className="form-grid"><label>Descripción<input required value={item.descripcion} onChange={(e) => setItem({ ...item, descripcion: e.target.value })} /></label><label>Neto (pesos)<input type="number" min="0" step="0.01" required value={item.neto} onChange={(e) => setItem({ ...item, neto: e.target.value })} /></label><label>Alícuota IVA<select value={item.alicuota} onChange={(e) => setItem({ ...item, alicuota: e.target.value })}><option value="0">0%</option><option value="10.5">10,5%</option><option value="21">21%</option><option value="27">27%</option></select></label></div></fieldset>
    <button type="submit" disabled={busy || !retryAllowed}>{busy ? "Emitiendo…" : "Emitir comprobante"}</button>
    {feedback && <p role={feedback.kind === "error" ? "alert" : "status"}>{feedback.text}</p>}
  </form>;
}
