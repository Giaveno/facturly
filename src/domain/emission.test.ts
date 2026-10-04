import { describe, it, expect } from "vitest";
import {
  assertRowEmittable,
  invoiceStatusForRow,
  isRowEmittable,
  RowNotEmittableError,
} from "./emission";

describe("emission guard — BLOCKED/REJECTED rows must never emit", () => {
  it("rejects a BLOCKED row", () => {
    expect(isRowEmittable("BLOCKED")).toBe(false);
    expect(() => assertRowEmittable("BLOCKED")).toThrow(RowNotEmittableError);
  });

  it("rejects a REJECTED row (invoice-level status, defense-in-depth)", () => {
    expect(isRowEmittable("REJECTED")).toBe(false);
    expect(() => assertRowEmittable("REJECTED")).toThrow(RowNotEmittableError);
  });

  it("allows a CORRECTED row to be emitted", () => {
    expect(isRowEmittable("CORRECTED")).toBe(true);
    expect(() => assertRowEmittable("CORRECTED")).not.toThrow();
  });

  it("allows a CONFIDENT row to be emitted (post-review)", () => {
    expect(isRowEmittable("CONFIDENT")).toBe(true);
  });

  it("rejects the async PENDING intermediate", () => {
    expect(isRowEmittable("PENDING")).toBe(false);
  });

  it("rejects a FAILED row — a crashed extraction is never emittable (W7/C1)", () => {
    expect(isRowEmittable("FAILED")).toBe(false);
    expect(() => assertRowEmittable("FAILED")).toThrow(RowNotEmittableError);
  });

  it("carries the offending status on the error", () => {
    try {
      assertRowEmittable("BLOCKED");
      throw new Error("expected assertRowEmittable to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RowNotEmittableError);
      expect((err as RowNotEmittableError).status).toBe("BLOCKED");
    }
  });
});

describe("invoice status mapping (dual status machine)", () => {
  it("maps BLOCKED ⇒ invoice stays PENDING (not emittable)", () => {
    expect(invoiceStatusForRow("BLOCKED")).toBe("PENDING");
  });

  it("maps CORRECTED ⇒ invoice becomes REVIEWED", () => {
    expect(invoiceStatusForRow("CORRECTED")).toBe("REVIEWED");
  });

  it("maps CONFIDENT ⇒ invoice stays PENDING (awaiting review)", () => {
    expect(invoiceStatusForRow("CONFIDENT")).toBe("PENDING");
  });

  it("maps PENDING ⇒ invoice stays PENDING", () => {
    expect(invoiceStatusForRow("PENDING")).toBe("PENDING");
  });
});
