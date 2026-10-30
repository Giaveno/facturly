import { afterEach, describe, expect, it, vi } from "vitest";
import { fiscalDate } from "./fiscal-date";

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("Argentine fiscal date", () => {
  it.each(["UTC", "America/Los_Angeles", "Asia/Tokyo"])("ignores host timezone %s", (zone) => {
    vi.stubEnv("TZ", zone);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-30T01:30:00Z"));
    expect(fiscalDate()).toBe("2026-10-29"); // 22:30 Argentina
    vi.setSystemTime(new Date("2026-10-30T03:30:00Z"));
    expect(fiscalDate()).toBe("2026-10-30"); // 00:30 Argentina
  });
});
