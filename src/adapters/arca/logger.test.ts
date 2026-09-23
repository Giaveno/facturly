import { describe, it, expect } from "vitest";
import {
  createInMemoryMetrics,
  createJsonLogger,
  noopLogger,
  noopMetrics,
} from "./logger";
import { runWithCorrelationId, correlationId } from "./correlation";

describe("logger — createJsonLogger", () => {
  it("emits structured JSON lines with a correlation id", async () => {
    const lines: string[] = [];
    const logger = createJsonLogger((line) => lines.push(line));

    await runWithCorrelationId("corr-123", () => {
      logger.info("op", { service: "wsfe", code: "10015" });
    });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.event).toBe("op");
    expect(parsed.correlation_id).toBe("corr-123");
    expect(parsed.service).toBe("wsfe");
    expect(parsed.code).toBe("10015");
    expect(parsed.level).toBe("info");
  });

  it("correlationId() returns a fresh id when no context is set", () => {
    const id = correlationId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("noopLogger/noopMetrics are safe to call", () => {
    expect(() => {
      noopLogger.info("x");
      noopLogger.error("y");
      noopMetrics.increment("z");
    }).not.toThrow();
    expect(noopMetrics.snapshot()).toEqual({});
  });
});

describe("logger — createInMemoryMetrics", () => {
  it("accumulates counters and snapshots them", () => {
    const m = createInMemoryMetrics();
    m.increment("arca_timeout");
    m.increment("arca_timeout");
    m.increment("arca_duplicate");
    expect(m.snapshot()).toEqual({ arca_timeout: 2, arca_duplicate: 1 });
  });
});
