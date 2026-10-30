"use client";

import React, { useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowUpRight, Building2, Check, FileImage, Info, Plus, ShieldCheck, Upload, X } from "lucide-react";

type UploadClient = { id: string; razonSocial: string; cuit: string };

export default function UploadForm({ clients }: { clients: UploadClient[] }) {
  const [clientId, setClientId] = useState(clients.length === 1 ? clients[0]?.id ?? "" : "");
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const selectedClient = clients.find(client => client.id === clientId);

  function addFiles(incoming: File[]) {
    setFiles(current => [...current, ...incoming.filter(file => !current.some(existing => existing.name === file.name && existing.size === file.size && existing.lastModified === file.lastModified))]);
    setFeedback("");
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || !files.length) return;
    setSubmitting(true);
    setFeedback("Cargando comprobantes…");
    const form = event.currentTarget;
    try {
      const data = new FormData(form);
      data.delete("photos");
      files.forEach(file => data.append("photos", file));
      const response = await fetch("/api/upload", { method: "POST", body: data });
      const result: { error?: string; rows?: unknown[] } = await response.json().catch(() => ({}));
      setFeedback(response.ok
        ? `Carga recibida. Se registraron ${result.rows?.length ?? 0} comprobante(s) para procesar.`
        : result.error ?? "No se pudo completar la carga. Revisá los archivos e intentá nuevamente.");
      if (response.ok) {
        form.reset();
        setFiles([]);
      }
    } catch {
      setFeedback("No se pudo conectar con el servicio. Revisá tu conexión e intentá nuevamente.");
    } finally {
      setSubmitting(false);
    }
  }

  return <div className="upload-layout">
    <form className="surface upload-main form-stack" onSubmit={onSubmit} aria-busy={submitting}>
      <div className="section-header"><div><h2>Nuevo lote</h2><p>Subí las imágenes y revisá los datos extraídos antes de continuar.</p></div><span className="batch-label">{files.length ? `${files.length} archivo(s)` : "Sin guardar"}</span></div>
      {clients.length ? <div className="client-selector"><span className="client-selector-icon"><Building2 size={18} aria-hidden="true" /></span><label>Empresa emisora<select name="clientId" value={clientId} onChange={event => setClientId(event.target.value)} required disabled={submitting}>
        <option value="" disabled>Seleccioná una empresa</option>
        {clients.map(client => <option key={client.id} value={client.id}>{client.razonSocial} · CUIT {client.cuit}</option>)}
      </select>{selectedClient && <small>CUIT {selectedClient.cuit}</small>}</label></div> : <div className="empty-state"><strong>Primero necesitás registrar una empresa emisora.</strong><p>Después vas a poder asociar cada carga a un cliente real.</p><Link className="button" href="/clients">Ir a Clientes</Link></div>}
      <div className={`dropzone ${dragging ? "is-dragging" : ""}`} onDragOver={event => { event.preventDefault(); if (!submitting && clients.length) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); if (!submitting && clients.length) addFiles(Array.from(event.dataTransfer.files)); }}>
        <span className="upload-icon"><Upload size={21} aria-hidden="true" /></span><h3>Arrastrá tus comprobantes acá</h3><p>o elegí archivos desde tu computadora</p>
        <input ref={input} className="sr-only" id="receipt-photos" name="photos" type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={submitting || !clients.length} aria-label="Fotos de comprobantes" onChange={event => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
        <button className="button" type="button" disabled={submitting || !clients.length} onClick={() => input.current?.click()}><Plus size={15} aria-hidden="true" />Elegir archivos</button>
        <small>JPG, PNG y WebP · Hasta 10 imágenes</small><small>10 MiB por archivo · Hasta 25 MiB por lote; el servidor valida los límites.</small>
      </div>
      {files.length > 0 && <div className="file-list"><div className="file-list-heading"><strong>{files.length} archivo(s) seleccionado(s)</strong><button className="text-button" type="button" disabled={submitting} onClick={() => setFiles([])}>Quitar todos</button></div>
        <ul>{files.map((file, index) => <li className="file-row" key={`${file.name}-${file.lastModified}-${index}`}><span className="file-thumb"><FileImage size={17} aria-hidden="true" /></span><div className="file-meta"><strong>{file.name}</strong><small>{new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(file.size / 1024 / 1024)} MiB · Seleccionado</small></div><Check className="file-check" size={16} aria-hidden="true" /><button className="icon-button" type="button" aria-label={`Quitar ${file.name}`} disabled={submitting} onClick={() => setFiles(current => current.filter((_, itemIndex) => itemIndex !== index))}><X size={16} aria-hidden="true" /></button></li>)}</ul>
      </div>}
      <div className="upload-footer"><p className="info-note"><Info size={15} aria-hidden="true" /><span>La carga registra los comprobantes para procesar. Después podés revisar y corregir los datos.</span></p><button type="submit" disabled={!clients.length || !clientId || !files.length || submitting}>{submitting ? "Cargando…" : "Cargar comprobantes"}<ArrowUpRight size={15} aria-hidden="true" /></button></div>
      {feedback && <p className="feedback" role="status">{feedback}</p>}
      <details className="privacy-note"><summary>Privacidad y procesamiento de imágenes</summary><p className="helper-note">El OCR con Gemini solo se activa explícitamente en el servidor. Si lo habilitás, usá únicamente comprobantes sintéticos o completamente anonimizados: las imágenes se envían a Google y el nivel de privacidad y las cuotas dependen de tu proyecto de AI Studio.</p></details>
    </form>
    <aside className="surface side-note"><span className="side-note-icon"><ShieldCheck size={20} aria-hidden="true" /></span><h3>Flujo seguro y controlado</h3><p>Cada dato extraído queda pendiente de revisión. Nada se emite sin tu aprobación.</p><ol className="process-steps"><li><span>01</span>Subís las fotos</li><li><span>02</span>Revisás los datos</li><li><span>03</span>Aprobás la emisión</li></ol></aside>
  </div>;
}
