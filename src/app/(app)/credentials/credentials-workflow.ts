import { HOMOLOGACION_UI_MS } from "@/adapters/arca/timeouts";
import type { CertificateInfo } from "@/lib/credentials/pem";
import type { ConnectionReport } from "@/lib/credentials/connection-check";

export interface CredentialsState {
  certificate: CertificateInfo | null;
  saving: boolean;
  checking: boolean;
  savedMessage: string;
  saveError: string;
  checkError: string;
  report: ConnectionReport | null;
}
export function initialCredentialsState(certificate: CertificateInfo | null): CredentialsState {
  return { certificate, saving: false, checking: false, savedMessage: "", saveError: "", checkError: "", report: null };
}

/** Testable client orchestration: storage success is independent from WSAA status. */
export function createCredentialsWorkflow(
  certificate: CertificateInfo | null,
  changed: (state: CredentialsState) => void,
  dependencies: { request: typeof fetch; saved: () => void },
) {
  let state = initialCredentialsState(certificate);
  let version = 0;
  let controller: AbortController | undefined;
  const update = (patch: Partial<CredentialsState>) => { state = { ...state, ...patch }; changed(state); };
  const cancel = () => { version++; controller?.abort(); };

  async function check() {
    if (state.saving || state.checking || !state.certificate) return;
    const fingerprint = state.certificate.fingerprint;
    const current = ++version;
    const abort = new AbortController(); controller = abort;
    const timer = setTimeout(() => abort.abort(), HOMOLOGACION_UI_MS);
    update({ checking: true, checkError: "", report: null });
    try {
      const response = await dependencies.request("/api/credentials/check", {
        method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ fingerprint }), signal: abort.signal,
      });
      if (!response.ok) throw new Error("check_failed");
      const result = await response.json() as ConnectionReport;
      if (result.certificate?.fingerprint !== fingerprint || result.environment !== "homologacion") throw new Error("certificate_changed");
      if (current === version) update({ report: result });
    } catch {
      if (current === version) update({ checkError: "No se pudo verificar la autenticación en homologación. Las credenciales guardadas se conservan. Compruebe el entorno y las autorizaciones de ARCA; luego vuelva a probar." });
    } finally {
      clearTimeout(timer);
      if (current === version) update({ checking: false });
    }
  }

  async function save(input: { certPem: string; keyPem: string }, reset: () => void) {
    if (state.saving) return;
    cancel();
    const current = version;
    update({ saving: true, checking: false, savedMessage: "", saveError: "", checkError: "", report: null });
    try {
      const response = await dependencies.request("/api/credentials", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error("save_failed");
      const info = await response.json() as CertificateInfo;
      // Clear the pasted PEMs BEFORE starting or awaiting a diagnostic request.
      reset();
      if (current !== version) return;
      update({ certificate: info, saving: false, savedMessage: `Credenciales guardadas. Titular: "${info.subjectCn}"; CUIT ${info.cuit ?? "no informado"}; vence ${info.notAfter}.` });
      dependencies.saved();
      void check();
    } catch {
      if (current === version) update({ saveError: "No se pudieron guardar las credenciales. Verifique el certificado y la clave e intente nuevamente." });
    } finally {
      if (current === version) update({ saving: false });
    }
  }

  return {
    state: () => state, save, check,
    updateCertificate(next: CertificateInfo | null) {
      if (next?.fingerprint === state.certificate?.fingerprint) return;
      cancel(); update({ ...initialCredentialsState(next) });
    },
    dispose: cancel,
  };
}
