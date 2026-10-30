import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The recover job is a THIN adapter over the already-tested
// `recoverStuckEmissions`. Here we prove the C2 wiring that was previously
// MISSING: the scheduled (cron) function is defined and its handler delegates
// to the recovery service. Its heavy production dependencies (Neon client, ARCA
// gateway) are mocked — the Inngest platform itself (scheduler,
// event delivery) is not exercised offline.
vi.mock("@/lib/emission/emission-service", () => ({
  recoverStuckEmissions: vi.fn(),
}));
vi.mock("@/lib/emission/gateway", () => ({ buildArcaGateway: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
import { recoverStuckEmissions } from "@/lib/emission/emission-service";
import { buildArcaGateway } from "@/lib/emission/gateway";
import { getDb } from "@/lib/db/client";
import { recoverStuckEmissionsJob } from "./recover";

type JobLike = {
  opts: { id: string; triggers?: Array<{ cron?: string }> };
  fn: (ctx: { step: { run: (id: string, run: () => unknown) => Promise<unknown> } }) => Promise<unknown>;
};

describe("recoverStuckEmissionsJob — scheduled recovery wiring (C2)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

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

  it.each([undefined, "false", "", "1", "yes"])(
    "skips without dependencies when EMISSIONS_ENABLED is %s",
    async (value) => {
      vi.stubEnv("EMISSIONS_ENABLED", value);
      const { fn } = recoverStuckEmissionsJob as unknown as JobLike;
      const step = { run: vi.fn(async (_id: string, run: () => unknown) => run()) };

      await expect(fn({ step })).resolves.toEqual({
        recovered: 0,
        skipped: true,
        reason: "emissions-disabled",
      });

      expect(getDb).not.toHaveBeenCalled();
      expect(buildArcaGateway).not.toHaveBeenCalled();
      expect(recoverStuckEmissions).not.toHaveBeenCalled();
      expect(step.run).not.toHaveBeenCalled();
    },
  );

  it.each(["true", " TRUE "])("delegates when EMISSIONS_ENABLED is %s", async (value) => {
    vi.stubEnv("EMISSIONS_ENABLED", value);
    const recover = vi.mocked(recoverStuckEmissions);
    const db = {} as ReturnType<typeof getDb>;
    const gateway = {} as ReturnType<typeof buildArcaGateway>;
    vi.mocked(getDb).mockReturnValue(db);
    vi.mocked(buildArcaGateway).mockReturnValue(gateway);
    recover.mockResolvedValue([
      { invoiceId: "invoice-1", outcome: "already_emitted", cbteNro: 4 },
      { invoiceId: "invoice-2", outcome: "failed_permanent" },
      { invoiceId: "invoice-3", outcome: "failed_transient" },
    ] as never);

    const { fn } = recoverStuckEmissionsJob as unknown as JobLike;
    const step = { run: vi.fn(async (_id: string, run: () => unknown) => run()) };
    await expect(fn({ step })).resolves.toEqual({ recovered: 1, rejected: 1, blocked: 1 });

    expect(step.run).toHaveBeenCalledWith("recover-stuck", expect.any(Function));
    expect(getDb).toHaveBeenCalledTimes(2);
    expect(buildArcaGateway).toHaveBeenCalledExactlyOnceWith(db);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledWith({
      db,
      gateway,
      emissionsEnabled: true,
      delayMs: 1000,
    });
  });
});
