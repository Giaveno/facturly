import { describe, expect, it, vi } from "vitest";

// The route is the single `serve(...)` that registers every background job.
// We mock the Inngest `serve` surface and assert the RECOVERY job is actually
// registered alongside the emit and OCR jobs (C2/C4). The handlers returned by
// `serve` are never invoked here — only the registration list is asserted.
const { serveMock } = vi.hoisted(() => {
  const m = vi.fn<
    (config: { functions: unknown[] }) => { GET: unknown; POST: unknown; PUT: unknown }
  >();
  m.mockReturnValue({ GET: () => {}, POST: () => {}, PUT: () => {} });
  return { serveMock: m };
});
vi.mock("inngest/next", () => ({ serve: serveMock }));

import { emitBatchJob } from "@/jobs/emit";
import { processOcrRowJob } from "@/jobs/ocr";
import { recoverStuckEmissionsJob } from "@/jobs/recover";
import "@/app/api/inngest/route";

describe("inngest route — function registration", () => {
  it("serves the emit, OCR, AND scheduled recovery jobs", () => {
    expect(serveMock).toHaveBeenCalledTimes(1);
    const functions = serveMock.mock.calls[0]![0].functions as unknown[];
    expect(functions).toContain(emitBatchJob);
    expect(functions).toContain(processOcrRowJob);
    expect(functions).toContain(recoverStuckEmissionsJob);
  });
});
