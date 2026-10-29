"use client";
import React, { useEffect, useRef, useState } from "react";
import { HOMOLOGACION_UI_MS } from "@/adapters/arca/timeouts";
import type { ConsultationReport } from "@/lib/invoices/reconciliation";
import { formatCentavos } from "@/domain/money";
import { safeQueryDiagnostic, type QueryDiagnostic } from "@/adapters/arca/query-diagnostics";
export interface ReservedAttemptRow {
    invoiceId: string;
    status: string;
    cuit: string;
    ptoVta: number;
    cbteTipo: number;
    cbteNro: number;
    importeTotalCentavos: number;
    canConsult: boolean;
    closedNoRecordAt?: string;
}
export const SERIES_BLOCKED_UI_MESSAGE = "serie bloqueada, pendiente de conciliación";
interface Result {
    report?: ConsultationReport;
    error?: string;
    diagnostic?: QueryDiagnostic;
}
const messages: Record<string, string> = {
    environment: "La reserva no tiene homologación verificable. No se consultó ARCA.",
    credentials: "Revise las credenciales guardadas.", changed: "La reserva o las credenciales cambiaron. Actualice la página.",
    not_found: "La reserva ya no está disponible.", cooldown: "Espere unos segundos antes de consultar nuevamente.",
};
function Attempt({ row, enabled }: {
    row: ReservedAttemptRow;
    enabled: boolean;
}) {
    const identity = JSON.stringify([row, enabled]);
    const currentIdentity = useRef(identity);
    currentIdentity.current = identity;
    const inFlight = useRef(false);
    const nextAllowedAt = useRef(0);
    const controller = useRef<AbortController | null>(null);
    const [busy, setBusy] = useState(false);
    const [cooldown, setCooldown] = useState(false);
    const [result, setResult] = useState<Result | null>(null);
    const mounted = useRef(true);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; controller.current?.abort(); if (timer.current)
            clearTimeout(timer.current); };
    }, []);
    async function consult() {
        if (inFlight.current || Date.now() < nextAllowedAt.current || cooldown || !enabled || !row.canConsult)
            return;
        inFlight.current = true;
        setBusy(true);
        setResult(null);
        const startedIdentity = identity;
        const request = new AbortController();
        controller.current = request;
        const timeout = setTimeout(() => request.abort(), HOMOLOGACION_UI_MS);
        const active = () => mounted.current && currentIdentity.current === startedIdentity && controller.current === request;
        try {
            const response = await fetch(`/api/invoices/${row.invoiceId}/consult`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", cache: "no-store", signal: request.signal });
            const data = await response.json();
            if (!active())
                return;
            if (!response.ok)
                setResult({ error: messages[data.code] ?? "No se pudo verificar el estado. El resultado fiscal sigue siendo desconocido.", diagnostic: safeQueryDiagnostic(data.diagnostic) });
            else if (data.invoiceId !== row.invoiceId || data.environment !== "homologacion" || data.tuple?.cuit !== row.cuit || data.tuple?.ptoVta !== row.ptoVta || data.tuple?.cbteTipo !== row.cbteTipo || data.tuple?.cbteNro !== row.cbteNro || !["matched", "unverified", "no-record"].includes(data.status))
                setResult({ error: "El resultado no corresponde a esta reserva. Actualice la página." });
            else
                setResult({ report: data });
        }
        catch {
            if (active())
                setResult({ error: "No se pudo verificar el estado. No se modificó la factura." });
        }
        finally {
            clearTimeout(timeout);
            if (active()) {
                nextAllowedAt.current = Date.now() + 15000;
                inFlight.current = false;
                setBusy(false);
                setCooldown(true);
                timer.current = setTimeout(() => { if (mounted.current)
                    setCooldown(false); }, 15000);
            }
        }
    }
    const report = result?.report;
    return <article className="card">
    <h3>Reserva {row.cbteTipo} / PV {row.ptoVta} / Nº {row.cbteNro}</h3>
    <p>CUIT emisor: {row.cuit} · Importe: {formatCentavos(row.importeTotalCentavos)}</p>
    <p>Referencia: {row.invoiceId}</p>
    {row.closedNoRecordAt ? <>
      <p>Intento anterior cerrado: la consulta histórica del {new Date(row.closedNoRecordAt).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" })} devolvió código 602 (sin registros en ese momento).</p>
      <p>Verificada: no existía en ARCA en esa consulta. No describe el estado actual de la numeración: ese número puede haber sido utilizado posteriormente por otro comprobante.</p>
    </> : <p>{["incierto", "EMIT_ERROR", "EMITTING"].includes(row.status) ? SERIES_BLOCKED_UI_MESSAGE : `Estado local: ${row.status}. Resultado fiscal sin verificar; no implica rechazo confirmado.`}</p>}
    {!row.closedNoRecordAt && <>
    <button type="button" onClick={consult} disabled={busy || cooldown || !enabled || !row.canConsult}>{busy ? "Consultando…" : "Consultar estado en ARCA (homologación)"}</button>
    {(!enabled || !row.canConsult) && <p>Consulta bloqueada: se requiere homologación actual y una aprobación original verificable en homologación.</p>}
    </>}
    <div role="status" aria-live="polite">
      {result?.error && <p>{result.error}</p>}
      {report && <>
        <p>{report.status === "matched" ? "ARCA devolvió una autorización CAE que coincide con la reserva. Solo lectura: la factura local no cambió." : report.status === "no-record" ? "ARCA devolvió código 602: sin registros devueltos. Esto no demuestra que nunca se haya emitido." : "ARCA devolvió datos sin coincidencia fiscal completa. Autorización de esta factura NO verificada."}</p>
        {report.cae && /^\d{14}$/.test(report.cae) && <p>CAE devuelto por ARCA: {report.cae} · Vencimiento: {report.caeFchVto}</p>}
        <p>Consulta: {report.checkedAt}</p>
      </>}
      {(result?.diagnostic ?? report?.diagnostic) && <p>Diagnóstico: {(result?.diagnostic ?? report?.diagnostic)!.stage} / {(result?.diagnostic ?? report?.diagnostic)!.category} · Códigos: {(result?.diagnostic ?? report?.diagnostic)!.providerCodes?.join(", ") ?? "—"}</p>}
    </div>
  </article>;
}
export function ReservedAttempts({ rows, enabled }: {
    rows: ReservedAttemptRow[];
    enabled: boolean;
}) {
    return <section aria-labelledby="reserved-attempts-title">
    <h2 id="reserved-attempts-title">Intentos anteriores con número reservado — sin CAE local</h2>
    <p>Solo homologación: comprobantes de prueba sin validez fiscal. Consultar no emite, reintenta ni cambia estados; tampoco habilita un PDF. Comparta el resultado antes de decidir cualquier recuperación.</p>
    {!rows.length && <p>No hay intentos con número reservado pendientes de verificación.</p>}
    {rows.map(row => <Attempt key={`${JSON.stringify(row)}:${enabled}`} row={row} enabled={enabled}/>)}
  </section>;
}
