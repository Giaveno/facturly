import { describe, expect, it, vi } from "vitest";

// The recover job is a THIN adapter over the already-tested
// `recoverStuckEmissions`. Here we prove the C2 wiring that was previously
// MISSING: the scheduled (cron) function is defined and its handler delegates
// to the recovery service. Its heavy production dependencies (Neon client, ARCA
// gateway, env switch) are mocked — the Inngest platform itself (scheduler,
// event delivery) is not exercised offline.
vi.mock("@/lib/emission/emission-service", () => ({
  recoverStuckEmissions: vi.fn(),
}));
vi.mock("@/lib/emission/gateway", () => ({ buildArcaGateway: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/adapters/arca/emissions", () => ({
  readEmissionsEnabled: vi.fn(() => false),
}));

import { recoverStuckEmissions } from "@/lib/emission/emission-service";
import { recoverStuckEmissionsJob } from "./recover";

type JobLike = {
  opts: { id: string; triggers?: Array<{ cron?: string }> };
  fn: (ctx: { step: { run: (id: string, run: () => unknown) => Promise<unknown> } }) => Promise<unknown>;
};

describe("recoverStuckEmissionsJob — scheduled recovery wiring (C2)", () => {
  it("is defined with the recovery id and a scheduled cron trigger", () => {
    expect(recoverStuckEmissionsJob).toBeDefined();
    const { opts } = recoverStuckEmissionsJob as unknown as JobLike;
    expect(opts.id).toBe("emission/recover-stuck");
    const cron = opts.triggers?.find((t) => typeof t.cron === "string");
    expect(cron).toBeDefined();
    // ~100 invoices/month → a 15-minute cadence recovers a lost CAE promptly
    // without a high-frequency cron bill (96 invocations/day, idempotent).
    expect(cron!.cron).toBe("*/15 * * * *");
  });

  it("handler delegates to recoverStuckEmissions", async () => {
    const recover = vi.mocked(recoverStuckEmissions);
    recover.mockResolvedValue([
      { invoiceId: "invoice-1", outcome: "emitted", cbteNro: 4 },
    ] as never);

    const { fn } = recoverStuckEmissionsJob as unknown as JobLike;
    const step = { run: async (_id: string, run: () => unknown) => run() };
    await fn({ step });

    expect(recover).toHaveBeenCalledTimes(1);
  });
});
