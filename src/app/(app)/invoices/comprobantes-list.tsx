"use client";
import { emissionDiagnostic, emissionPhaseLabels, comprobanteStatusLabel } from "@/domain/emission-diagnostic";
import React, { useEffect, useState } from "react";
interface Company { id: string; razonSocial: string; }
interface Comprobante { id: string; empresaId: string; estado: string; resultado?: string | null; cbteTipo?: number | null; cbteNro?: number | null; cae?: string | null; caeVto?: string | null; errores?: string | null }
export function canAnnulComprobante(row: Pick<Comprobante, "estado" | "cbteTipo" | "cae">): boolean {
  return row.estado === "aprobado" && Boolean(row.cae) && [1, 6, 11].includes(row.cbteTipo ?? 0);
}
export function VerificationAction({ estado, disabled, verifying, onVerify }: { estado: string; disabled: boolean; verifying: boolean; onVerify: () => void }) {
  return estado === "incierto" ? <button type="button" disabled={disabled} onClick={onVerify}>{verifying ? "Verificando..." : "Verificar en ARCA"}</button> : null;
}
export function KnownArcaCause({ estado, errores }: Pick<Comprobante, "estado" | "errores">) {
  const diagnostic = emissionDiagnostic(errores);
  return <>{diagnostic.phase && <strong>Fase: {emissionPhaseLabels[diagnostic.phase] ?? diagnostic.phase}. </strong>}{diagnostic.cause || (estado === "incierto" ? "Autorización pendiente de verificar en ARCA; no vuelva a emitir." : "-")}</>;
}
export default function ComprobantesList() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [empresaId, setEmpresaId] = useState("");
  const [rows, setRows] = useState<Comprobante[]>([]); const [error, setError] = useState("");
  useEffect(() => { fetch("/api/clients", { cache: "no-store" }).then(async (response) => { if (!response.ok) throw new Error(); const data = await response.json(); const list = Array.isArray(data) ? data : data.clients ?? []; setCompanies(list); if (list[0]?.id) setEmpresaId(list[0].id); }).catch(() => setError("No se pudieron cargar las empresas.")); }, []);
  useEffect(() => { if (!empresaId) { setRows([]); return; } const controller = new AbortController(); fetch(`/api/comprobantes?empresaId=${encodeURIComponent(empresaId)}`, { cache: "no-store", signal: controller.signal }).then(async (response) => { if (!response.ok) throw new Error(); const data = await response.json(); if (!controller.signal.aborted) setRows(Array.isArray(data) ? data : data.comprobantes ?? []); }).catch(() => { if (!controller.signal.aborted) setError("No se pudo cargar el listado de comprobantes."); }); return () => controller.abort(); }, [empresaId]);
  const [verifying, setVerifying] = useState<string | null>(null);
  const verify = async (id: string) => {
    setError(""); setVerifying(id);
    try {
      const response = await fetch(`/api/comprobantes/${id}/verify`, { method: "POST", headers: { "x-empresa-id": empresaId } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "No se pudo verificar el comprobante.");
      setRows(current => current.map(row => row.id === id ? { ...row, ...data } : row));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo verificar el comprobante."); }
    finally { setVerifying(null); }
  };
  const issueCreditNote = async (id: string) => {
    setError("");
    const response = await fetch(`/api/comprobantes/${id}/credit-note`, { method: "POST", headers: { "x-empresa-id": empresaId } });
    if (!response.ok) { setError("No se pudo emitir la nota de crédito."); return; }
    const refreshed = await fetch(`/api/comprobantes?empresaId=${encodeURIComponent(empresaId)}`, { cache: "no-store" });
    if (refreshed.ok) setRows(await refreshed.json());
  };
  return <section className="page-section" aria-labelledby="comprobantes-title"><h2 id="comprobantes-title">Comprobantes</h2><label>Empresa<select value={empresaId} onChange={(event) => setEmpresaId(event.target.value)}><option value="">Selecciona una empresa</option>{companies.map((company) => <option key={company.id} value={company.id}>{company.razonSocial}</option>)}</select></label>{error && <p role="alert">{error}</p>}{empresaId && !error && rows.length === 0 ? <p>A&#xFA;n no hay comprobantes emitidos.</p> : empresaId ? <div className="table-wrap"><table><thead><tr><th>Estado</th><th>Tipo / n&#xFA;mero</th><th>CAE</th><th>Vencimiento</th><th>Detalle ARCA</th><th>PDF</th><th>Acciones</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td><span className={`status-pill ${row.estado === "aprobado" ? "status-ready" : row.estado === "incierto" ? "status-warning" : "status-muted"}`}>{comprobanteStatusLabel(row)}</span></td><td>{row.cbteTipo ?? "-"} / {row.cbteNro ?? "-"}</td><td>{row.cae ?? "-"}</td><td>{row.caeVto ?? "-"}</td><td><KnownArcaCause estado={row.estado} errores={row.errores} /></td><td>{row.estado === "aprobado" && row.cae ? <a href={`/api/comprobantes/${row.id}/pdf?empresaId=${encodeURIComponent(row.empresaId)}`}>Descargar PDF</a> : "-"}</td><td>{row.estado === "incierto" ? <VerificationAction estado={row.estado} disabled={verifying !== null} verifying={verifying === row.id} onVerify={() => verify(row.id)} /> : canAnnulComprobante(row) ? <button type="button" onClick={() => issueCreditNote(row.id)}>Anular / Nota de crédito</button> : "-"}</td></tr>)}</tbody></table></div> : null}</section>;
}

