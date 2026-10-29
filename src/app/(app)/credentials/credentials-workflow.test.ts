import { expect, it, vi } from "vitest";
import { createCredentialsWorkflow } from "./credentials-workflow";
import type { CertificateInfo } from "@/lib/credentials/pem";

const certificate: CertificateInfo = { fingerprint: "a".repeat(64), subjectCn: "TEST", cuit: null, notBefore: "2026", notAfter: "2027" };
const report = { environment: "homologacion", certificate, services: [{ service: "wsfe", status: "ok" }, { service: "ws_sr_constancia_inscripcion", status: "ok" }] };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
it("keeps save success, clears sensitive inputs immediately, then checks only the persisted public identity", async () => {
  let resolveCheck!: (value: Response) => void;
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(certificate)).mockImplementationOnce(() => new Promise(resolve => { resolveCheck = resolve; }));
  const reset = vi.fn(); const saved = vi.fn(); const flow = createCredentialsWorkflow(null, vi.fn(), { request, saved });
  await flow.save({ certPem: "CERT", keyPem: "PRIVATE_SECRET" }, reset);
  expect(reset).toHaveBeenCalledOnce(); expect(saved).toHaveBeenCalledOnce();
  expect(flow.state().savedMessage).toContain("Credenciales guardadas"); expect(flow.state().checking).toBe(true); expect(flow.state().saving).toBe(false);
  expect(request.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ fingerprint: certificate.fingerprint }));
  expect(JSON.stringify(flow.state())).not.toContain("PRIVATE_SECRET");
  resolveCheck(new Response("offline", { status: 503 })); await flush();
  expect(flow.state().savedMessage).toContain("Credenciales guardadas"); expect(flow.state().saveError).toBe(""); expect(flow.state().checkError).not.toBe("");
});
it("retains stored success when diagnostic network fails and allows explicit retry", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(certificate)).mockRejectedValueOnce(new Error("SECRET payload")).mockResolvedValueOnce(Response.json(report));
  const flow = createCredentialsWorkflow(null, vi.fn(), { request, saved: vi.fn() });
  await flow.save({ certPem: "CERT", keyPem: "KEY" }, vi.fn()); await flush();
  expect(flow.state().checkError).not.toMatch(/SECRET/); expect(flow.state().savedMessage).toContain("guardadas");
  await flow.check(); expect(flow.state().report).toEqual(report); expect(flow.state().savedMessage).toContain("guardadas");
});
it("does not check, reset, refresh or claim storage success after a failed save", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("bad", { status: 400 })); const reset = vi.fn(); const saved = vi.fn();
  const flow = createCredentialsWorkflow(null, vi.fn(), { request, saved });
  await flow.save({ certPem: "CERT", keyPem: "KEY" }, reset);
  expect(request).toHaveBeenCalledTimes(1); expect(reset).not.toHaveBeenCalled(); expect(saved).not.toHaveBeenCalled();
  expect(flow.state().savedMessage).toBe(""); expect(flow.state().saveError).not.toBe("");
});
it("blocks duplicate submissions and repeated checks while pending", async () => {
  let resolveSave!: (response: Response) => void;
  const request = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(resolve => { resolveSave = resolve; })).mockImplementationOnce(() => new Promise(() => {}));
  const flow = createCredentialsWorkflow(certificate, vi.fn(), { request, saved: vi.fn() });
  const pending = flow.save({ certPem: "CERT", keyPem: "KEY" }, vi.fn());
  await flow.save({ certPem: "CERT", keyPem: "KEY" }, vi.fn()); await flow.check(); expect(request).toHaveBeenCalledTimes(1);
  resolveSave(Response.json(certificate)); await pending; await flow.check(); expect(request).toHaveBeenCalledTimes(2); flow.dispose();
});
it("ignores stale check results after a newer save or external certificate replacement", async () => {
  let resolveOld!: (response: Response) => void; const second = { ...certificate, fingerprint: "b".repeat(64) };
  const request = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValueOnce(Response.json(second)).mockResolvedValueOnce(Response.json({ ...report, certificate: second }));
  const flow = createCredentialsWorkflow(certificate, vi.fn(), { request, saved: vi.fn() });
  const old = flow.check(); await flow.save({ certPem: "SECOND", keyPem: "KEY" }, vi.fn()); await flush();
  resolveOld(Response.json(report)); await old;
  expect(flow.state().certificate?.fingerprint).toBe(second.fingerprint); expect(flow.state().report?.certificate?.fingerprint).toBe(second.fingerprint);
  flow.updateCertificate(certificate); expect(flow.state().report).toBeNull(); expect(flow.state().checking).toBe(false);
});
it("never accepts a success report for another certificate", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...report, certificate: { ...certificate, fingerprint: "b".repeat(64) } }));
  const flow = createCredentialsWorkflow(certificate, vi.fn(), { request, saved: vi.fn() }); await flow.check();
  expect(flow.state().report).toBeNull(); expect(flow.state().checkError).not.toBe("");
});
