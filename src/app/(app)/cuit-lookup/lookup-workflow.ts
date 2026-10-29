import { HOMOLOGACION_UI_MS } from "@/adapters/arca/timeouts";
import { normalizeLookupCuit, type PadronLookupReport } from "@/lib/padron/contract";
import { safeQueryDiagnostic } from "@/adapters/arca/query-diagnostics";

export interface LookupState { cuit: string; checking: boolean; report: PadronLookupReport | null; error: string | null }
export const initialLookupState: LookupState = { cuit: "", checking: false, report: null, error: null };
const genericFailure = "No se pudo consultar el Padrón de homologación. No se determinó la condición frente al IVA.";
function parseReport(value: unknown, cuit: string, fingerprint: string): PadronLookupReport | null {
  if (!value || typeof value !== "object") return null;
  const report = value as PadronLookupReport;
  if (report.cuit !== cuit || report.fingerprint !== fingerprint || report.environment !== "homologacion" || report.authentication !== "authenticated" || report.dataResponse !== "received" || !["found", "not_found"].includes(report.status) || !["ri", "monotributista", "exento", "no-determinada"].includes(report.condition) || !["explicit_tax", "no_supported_tax", "ambiguous_data", "not_found"].includes(report.reason) || typeof report.checkedAt !== "string" || !Number.isFinite(Date.parse(report.checkedAt))) return null;
  if (report.razonSocial !== undefined && (typeof report.razonSocial !== "string" || report.razonSocial.length > 401 || /[\u0000-\u001f\u007f]/.test(report.razonSocial))) return null;
  if (report.status === "not_found" ? report.condition !== "no-determinada" || report.reason !== "not_found" : report.reason === "not_found" || (report.condition === "no-determinada") === (report.reason === "explicit_tax")) return null;
  return { cuit, fingerprint, environment: "homologacion", authentication: "authenticated", dataResponse: "received", status: report.status, condition: report.condition, reason: report.reason, checkedAt: report.checkedAt, ...(report.razonSocial ? { razonSocial: report.razonSocial } : {}) };
}
function failureMessage(value: unknown, status: number): string {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const local: Record<string, string> = {
    credentials: "Revise el certificado y la clave guardados; el certificado debe identificar un CUIT válido.",
    changed: "Las credenciales cambiaron. Actualice la página antes de consultar.",
    environment: "La consulta requiere ARCA_ENV=homologacion.",
    timeout: "La consulta superó el tiempo de espera.",
    cooldown: "Espere 15 segundos antes de consultar otro CUIT.",
    invalid_cuit: "Ingrese un CUIT válido, incluido su dígito verificador.",
    upstream: genericFailure,
  };
  let message = status === 401 ? "Inicie sesión nuevamente." : status === 403 ? "La solicitud fue rechazada por su origen." : typeof body.code === "string" && Object.hasOwn(local, body.code) ? local[body.code]! : genericFailure;
  const diagnostic = safeQueryDiagnostic(body.diagnostic);
  if (diagnostic) message += ` Etapa: ${diagnostic.stage}. Categoría: ${diagnostic.category}.${diagnostic.httpStatus ? ` HTTP ${diagnostic.httpStatus}.` : ""}${diagnostic.providerCodes?.length ? ` Códigos ARCA: ${diagnostic.providerCodes.join(", ")}.` : ""}`;
  if (diagnostic?.faultReason) message += ` Detalle seguro: ${diagnostic.faultReason}.`;
  if (typeof body.correlationId === "string" && /^[a-f0-9-]{36}$/.test(body.correlationId)) message += ` Referencia: ${body.correlationId}.`;
  return message;
}
export function createLookupWorkflow(initialFingerprint: string, publish: (state: LookupState) => void, fetchFn: typeof fetch) {
  let state = initialLookupState; let fingerprint = initialFingerprint; let sequence = 0; let disposed = false; let controller: AbortController | undefined;
  const update = (patch: Partial<LookupState>) => { state = { ...state, ...patch }; if (!disposed) publish(state); };
  const clear = () => { sequence++; controller?.abort(); update({ checking: false, report: null, error: null }); };
  return {
    activate() { disposed = false; publish(state); },
    setCuit(cuit: string) { clear(); update({ cuit }); },
    setFingerprint(value: string) { if (value !== fingerprint) { fingerprint = value; clear(); } },
    dispose() { disposed = true; sequence++; controller?.abort(); state = { ...state, checking: false, report: null, error: null }; },
    async check() {
      if (disposed || state.checking) return;
      const cuit = normalizeLookupCuit(state.cuit);
      if (!cuit || !/^[a-f0-9]{64}$/.test(fingerprint)) { update({ report: null, error: "Ingrese un CUIT válido y cargue un certificado antes de consultar." }); return; }
      const current = ++sequence; const identity = fingerprint;
      const request = new AbortController(); controller = request; update({ checking: true, report: null, error: null });
      let timer: ReturnType<typeof setTimeout>; let timedOut = false;
      let cancel!: () => void;
      const cancellation = new Promise<never>((_, reject) => {
        cancel = () => reject(new Error("Request cancelled"));
        request.signal.addEventListener("abort", cancel, { once: true });
        timer = setTimeout(() => { timedOut = true; request.abort(); }, HOMOLOGACION_UI_MS);
      });
      try {
        const { response, value } = await Promise.race([(async () => {
          const response = await fetchFn("/api/padron/lookup", { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", body: JSON.stringify({ cuit, fingerprint: identity }), signal: request.signal });
          const value: unknown = await response.json(); return { response, value };
        })(), cancellation]);
        if (disposed || current !== sequence) return;
        if (!response.ok) { update({ checking: false, error: failureMessage(value, response.status) }); return; }
        const report = parseReport(value, cuit, identity);
        update({ checking: false, report, error: report ? null : genericFailure });
      } catch { if (!disposed && current === sequence) update({ checking: false, error: timedOut ? "La consulta superó el tiempo de espera. Puede reintentar." : genericFailure }); }
      finally { clearTimeout(timer!); request.signal.removeEventListener("abort", cancel); request.abort(); }
    },
  };
}
