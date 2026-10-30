import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/emission/review-emission-service", () => ({ emitReviewedBatch: vi.fn() }));
vi.mock("@/lib/emission/gateway", () => ({ buildArcaGateway: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/adapters/arca/emissions", () => ({ readEmissionsEnabled: vi.fn(() => true) }));
import { emitReviewedBatch } from "@/lib/emission/review-emission-service";
import { buildArcaGateway } from "@/lib/emission/gateway";
import { readEmissionsEnabled } from "@/adapters/arca/emissions";
import { emitBatchJob } from "./emit";

const runJob = () => (emitBatchJob as unknown as { fn: (ctx: unknown) => Promise<unknown> }).fn({
  event: { data: { invoiceIds: ["invoice-1"] } },
  step: { run: async (_id: string, run: () => unknown) => run() },
});
describe("emission job truthful safe summary", () => {
  beforeEach(() => vi.resetAllMocks());
  it("skips before constructing the gateway when emissions are disabled", async () => {
    vi.mocked(readEmissionsEnabled).mockReturnValue(false);
    expect(await runJob()).toEqual({ emitted: 0, alreadyEmitted: 0, failed: 0, outcomes: [], skipped: true, reason: "emissions-disabled" });
    expect(buildArcaGateway).not.toHaveBeenCalled();
    expect(emitReviewedBatch).not.toHaveBeenCalled();
  });
  it("reports zero emitted when all rows failed, with safe actionable outcomes", async () => {
    vi.mocked(emitReviewedBatch).mockResolvedValue([{ invoiceId: "invoice-1", outcome: "failed_permanent", error: "SECRET_RAW_SOAP", arcaCode: "11002", stage: "ultimo", category: "provider-errors", providerCodes: [11002] }] as never);
    const summary = await runJob();
    expect(summary).toEqual({ emitted: 0, alreadyEmitted: 0, failed: 1, outcomes: [{ invoiceId: "invoice-1", outcome: "failed_permanent", arcaCode: "11002", stage: "ultimo", category: "provider-errors", providerCodes: [11002] }] });
    expect(JSON.stringify(summary)).not.toContain("SECRET");
  });
  it("distinguishes newly emitted, already emitted and each failure", async () => {
    vi.mocked(emitReviewedBatch).mockResolvedValue(["emitted", "already_emitted", "failed_transient", "failed_permanent", "failed_collision"].map((outcome, i) => ({ invoiceId: `invoice-${i}`, outcome })) as never);
    expect(await runJob()).toMatchObject({ emitted: 1, alreadyEmitted: 1, failed: 3 });
  });
});





it("checkpoints distinct invoices separately instead of one batch request", async () => {
  vi.mocked(readEmissionsEnabled).mockReturnValue(true);
  vi.mocked(emitReviewedBatch).mockResolvedValue([]);
  const steps: string[] = [];
  await (emitBatchJob as unknown as { fn: (ctx: unknown) => Promise<unknown> }).fn({
    event: { id: "job-checkpoint", data: { invoiceIds: ["one", "two", "one"] } },
    step: { run: async (id: string, work: () => unknown) => { steps.push(id); return work(); } },
  });
  expect(steps).toEqual(["emit-invoice-one", "emit-invoice-two"]);
  expect(vi.mocked(emitReviewedBatch).mock.calls.slice(-2).map(call => call[1])).toEqual([["one"], ["two"]]);
});
