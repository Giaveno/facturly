import { afterEach, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createLookupWorkflow, initialLookupState } from "./lookup-workflow";
import LookupForm from "./lookup-form";
import type { PadronLookupReport } from "@/lib/padron/lookup";
const fingerprint = "a".repeat(64);
afterEach(() => vi.useRealTimers());
const report: PadronLookupReport = { cuit: "30710145764", fingerprint, environment: "homologacion", checkedAt: "2026-10-28T00:00:00Z", authentication: "authenticated", dataResponse: "received", status: "found", condition: "ri", reason: "explicit_tax", razonSocial: "TEST SA" };
function setup(fetchFn = vi.fn<typeof fetch>(async () => Response.json(report))) {
  let state = initialLookupState;
  const workflow = createLookupWorkflow(fingerprint, next => { state = next; }, fetchFn);
  workflow.setCuit("30-71014576-4");
  return { workflow, fetchFn, get state() { return state; } };
}
it("submits normalized CUIT and public identity; clears prior result on edit/new request", async () => {
  const s = setup(); await s.workflow.check(); expect(s.state.report).toEqual(report);
  expect(s.fetchFn.mock.calls[0]![0]).toBe("/api/padron/lookup"); expect(JSON.parse(String(s.fetchFn.mock.calls[0]![1]?.body))).toEqual({ cuit: report.cuit, fingerprint });
  s.workflow.setCuit("20-12345678-6"); expect(s.state.report).toBeNull(); expect(s.state.error).toBeNull();
});
it("rejects invalid input and stale/forged result identity; never trusts error text", async () => {
  const s = setup(); s.workflow.setCuit("abc30710145764"); await s.workflow.check(); expect(s.fetchFn).not.toHaveBeenCalled(); expect(s.state.error).toBeTruthy();
  for (const patch of [{ cuit: "20123456786" }, { fingerprint: "b".repeat(64) }, { environment: "production" }, { condition: "consumidorFinal" }, { reason: "invented" }]) {
    const s = setup(vi.fn(async () => Response.json({ ...report, ...patch }))); await s.workflow.check(); expect(s.state.report).toBeNull(); expect(s.state.error).toBeTruthy();
  }
  const failure = setup(vi.fn(async () => Response.json({ error: "SECRET faultstring", code: "upstream", diagnostic: { stage: "padron", category: "provider-errors", providerCodes: [602], message: "SECRET" } }, { status: 502 })));
  await failure.workflow.check(); expect(failure.state.error).toContain("padron"); expect(failure.state.error).not.toMatch(/SECRET|faultstring/);
});
it.each(["input", "identity", "dispose"])('ignores late response on %s change even when fetch ignores abort', async change => {
  let release!: (value: Response) => void;
  const s = setup(vi.fn(() => new Promise(resolve => { release = resolve; })));
  const pending = s.workflow.check(); expect(s.state.checking).toBe(true);
  if (change === "input") s.workflow.setCuit("20123456786");
  if (change === "identity") s.workflow.setFingerprint("b".repeat(64));
  if (change === "dispose") s.workflow.dispose();
  release(Response.json(report)); await pending; expect(s.state.report).toBeNull();
});
it("does not issue duplicate submissions while busy", async () => {
  let release!: (value: Response) => void;
  const s = setup(vi.fn(() => new Promise(resolve => { release = resolve; })));
  const pending = s.workflow.check(); await s.workflow.check(); expect(s.fetchFn).toHaveBeenCalledTimes(1); release(Response.json(report)); await pending;
});
it("shows only allowlisted fault subtypes and never interprets unknown reasons", async () => {
  for (const faultReason of ["validation-rejected", "unclassified", "SECRET_TOKEN"]) {
    const s = setup(vi.fn(async () => Response.json({ code: "upstream", diagnostic: { stage: "padron", category: "soap-fault", httpStatus: 500, faultReason } }, { status: 502 })));
    await s.workflow.check();
    expect(s.state.error).toContain("HTTP 500");
    expect(s.state.error).not.toContain("SECRET");
    if (faultReason !== "SECRET_TOKEN") expect(s.state.error).toContain(`Detalle seguro: ${faultReason}.`);
  }
});
it("survives React Strict Mode effect cleanup and reactivation", async () => {
  const s = setup(); s.workflow.dispose(); s.workflow.activate(); await s.workflow.check(); expect(s.state.report).toEqual(report);
});
it.each(["fetch", "body"])('bounds stalled %s independently of fetch abort support and ignores late results', async stage => {
  vi.useFakeTimers(); let release!: (value: Response) => void;
  const fetchFn = stage === "fetch" ? vi.fn<typeof fetch>(() => new Promise(resolve => { release = resolve; })) : vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ start() {} })));
  const s = setup(fetchFn); const pending = s.workflow.check(); await vi.advanceTimersByTimeAsync(70100); await pending;
  expect(s.state.checking).toBe(false); expect(s.state.report).toBeNull(); expect(s.state.error).toContain("tiempo de espera");
  if (stage === "fetch") { release(Response.json(report)); await Promise.resolve(); expect(s.state.report).toBeNull(); }
});
it("renders prominent test-data disclaimer and disabled non-homologation form", () => {
  const html = renderToStaticMarkup(React.createElement(LookupForm, { fingerprint, enabled: false }));
  expect(html).toContain("Homologación: datos de prueba; no acredita situación fiscal real"); expect(html).toContain("disabled"); expect(html).toContain("CUIT"); expect(html).not.toContain("Crear cliente");
});
