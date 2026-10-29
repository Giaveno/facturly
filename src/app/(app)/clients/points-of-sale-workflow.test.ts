import { afterEach, expect, it, vi } from "vitest";
import { createPointsOfSaleWorkflow } from "./points-of-sale-workflow";
import type { PointsOfSaleReport } from "@/lib/clients/points-of-sale";
const client = { id: "client", cuit: "30710145764", ptoVta: 12345, razonSocial: "TEST", condicionIva: "ri" };
const fingerprint = "a".repeat(64);
const report: PointsOfSaleReport = { environment: "homologacion", client, fingerprint, checkedAt: "2026-10-28T12:00:00Z", points: [], configuredPoint: "not_returned" };
afterEach(() => vi.useRealTimers());
it("queries explicitly once without sending arbitrary fiscal fields and retains the configured PV", async () => {
  let resolve!: (response: Response) => void;
  const request = vi.fn<typeof fetch>(() => new Promise(done => { resolve = done; }));
  const flow = createPointsOfSaleWorkflow(client, fingerprint, vi.fn(), request);
  const pending = flow.check(); await flow.check(); expect(request).toHaveBeenCalledTimes(1); expect(flow.state().checking).toBe(true);
  expect(request).toHaveBeenCalledWith("/api/clients/client/points-of-sale", expect.objectContaining({ method: "POST", cache: "no-store", body: JSON.stringify({ fingerprint }) }));
  resolve(Response.json(report)); await pending; expect(flow.state().report).toEqual(report); expect(client.ptoVta).toBe(12345);
});
it.each(["fingerprint", "client", "environment"])("rejects response with stale %s", async value => {
  const data = { ...report, ...(value === "fingerprint" ? { fingerprint: "b".repeat(64) } : value === "client" ? { client: { ...client, ptoVta: 2 } } : { environment: "production" }) };
  const flow = createPointsOfSaleWorkflow(client, fingerprint, vi.fn(), vi.fn(async () => Response.json(data)));
  await flow.check(); expect(flow.state().report).toBeNull(); expect(flow.state().error).not.toBe("");
});
it("discards an in-flight response after edit/invalidation or unmount", async () => {
  let resolve!: (response: Response) => void;
  const flow = createPointsOfSaleWorkflow(client, fingerprint, vi.fn(), vi.fn(() => new Promise<Response>(done => { resolve = done; })));
  const pending = flow.check(); flow.dispose(); resolve(Response.json(report)); await pending;
  expect(flow.state().report).toBeNull(); expect(flow.state().checking).toBe(false);
});
it("clears previous verification before a retry and never displays raw error text", async () => {
  const request = vi.fn<typeof fetch>(async () => Response.json(report)); const flow = createPointsOfSaleWorkflow(client, fingerprint, vi.fn(), request);
  await flow.check(); expect(flow.state().report).not.toBeNull();
  request.mockResolvedValue(Response.json({ error: "SECRET_TOKEN PRIVATE KEY" }, { status: 502 })); await flow.check();
  expect(flow.state().report).toBeNull(); expect(flow.state().error).not.toMatch(/SECRET|PRIVATE/);
});
it("bounds even an uncooperative browser fetch", async () => {
  vi.useFakeTimers(); const flow = createPointsOfSaleWorkflow(client, fingerprint, vi.fn(), vi.fn(() => new Promise<Response>(() => {})));
  const pending = flow.check(); await vi.advanceTimersByTimeAsync(70100); await pending;
  expect(flow.state().checking).toBe(false); expect(flow.state().error).not.toBe("");
});
it("shows safe stage, category, numeric status/codes and correlation ID without F12", async () => {
  const flow = createPointsOfSaleWorkflow(client, fingerprint, vi.fn(), vi.fn(async () => Response.json({ code: "upstream", error: "SECRET_TOKEN", diagnostic: { stage: "wsfe", category: "provider-errors", httpStatus: 500, providerCodes: [602, "PRIVATE KEY", -1] }, correlationId: "11111111-1111-4111-8111-111111111111" }, { status: 502 })));
  await flow.check(); expect(flow.state().error).toMatch(/WSFE/); expect(flow.state().error).toMatch(/602/); expect(flow.state().error).toMatch(/HTTP 500/); expect(flow.state().error).toContain("11111111-1111-4111-8111-111111111111");
  expect(flow.state().error).not.toMatch(/SECRET|PRIVATE|autorizaci/);
});
it("rejects arbitrary diagnostic strings and explains local stale credentials safely", async () => {
  const request = vi.fn<typeof fetch>(async () => Response.json({ code: "changed", error: "SECRET", correlationId: "PRIVATE", diagnostic: { stage: "SECRET", category: "PRIVATE" } }, { status: 409 }));
  const flow = createPointsOfSaleWorkflow(client, fingerprint, vi.fn(), request); await flow.check();
  expect(flow.state().error).toMatch(/cambiaron/); expect(flow.state().error).not.toMatch(/SECRET|PRIVATE/);
});

it("shows only bounded WSAA fault diagnostics in the homologation workflow",async()=>{
  const flow=createPointsOfSaleWorkflow(client,fingerprint,vi.fn(),vi.fn(async()=>Response.json({code:"upstream",diagnostic:{stage:"wsaa",category:"soap-fault",faultcode:"ns1:coe.alreadyAuthenticated",faultstring:"El CEE ya posee un TA valido token=SECRET_TOKEN"}},{status:502})));
  await flow.check();expect(flow.state().error).toContain("alreadyAuthenticated");expect(flow.state().error).toContain("El CEE ya posee");expect(flow.state().error).not.toContain("SECRET_TOKEN");
});

it("never exposes the short tail of reflected wrapped CMS in the screen",async()=>{
  const flow=createPointsOfSaleWorkflow(client,fingerprint,vi.fn(),vi.fn(async()=>Response.json({code:"upstream",diagnostic:{stage:"wsaa",category:"soap-fault",faultstring:"A".repeat(76)+"\nSHORT_SECRET_TAIL"}},{status:502})));
  await flow.check();expect(flow.state().error).not.toContain("SHORT_SECRET_TAIL");
});
