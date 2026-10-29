"use client";
import { useEffect, useState } from "react";
interface Comprobante { id: string; estado: string; cbteTipo?: number | null; cbteNro?: number | null; cae?: string | null; caeVto?: string | null; errores?: string | null }
export default function ComprobantesList() {
  const [rows, setRows] = useState<Comprobante[]>([]); const [error, setError] = useState("");
  useEffect(() => { fetch("/api/comprobantes", { cache: "no-store" }).then(async (response) => { if (!response.ok) throw new Error(); const data = await response.json(); setRows(Array.isArray(data) ? data : data.comprobantes ?? []); }).catch(() => setError("No se pudo cargar el listado de comprobantes.")); }, []);
  return <section className="page-section" aria-labelledby="comprobantes-title"><h2 id="comprobantes-title">Comprobantes</h2>{error && <p role="alert">{error}</p>}{!error && rows.length === 0 ? <p>Aún no hay comprobantes emitidos.</p> : <div className="table-wrap"><table><thead><tr><th>Estado</th><th>Tipo / número</th><th>CAE</th><th>Vencimiento</th><th>Detalle ARCA</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td><span className={`status-pill ${row.estado === "aprobado" ? "status-ready" : row.estado === "incierto" ? "status-warning" : "status-muted"}`}>{row.estado}</span></td><td>{row.cbteTipo ?? "—"} / {row.cbteNro ?? "—"}</td><td>{row.cae ?? "—"}</td><td>{row.caeVto ?? "—"}</td><td>{row.errores ?? "—"}</td></tr>)}</tbody></table></div>}</section>;
}
