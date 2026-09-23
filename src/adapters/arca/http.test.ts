import { describe, it, expect } from "vitest";
import {
  ArcaAuthError,
  ArcaBusinessError,
  ArcaTransientError,
} from "./errors";
import {
  createFetchTransport,
  DEFAULT_TIMEOUT_MS,
  parseRetryAfterMs,
} from "./http";

/** A minimal Response-shaped object with a configurable body/text behavior. */
function response(
  status: number,
  body: string,
  headers: Record<string, string> = {},
  textImpl?: () => Promise<string>,
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    text: textImpl ?? (async () => body),
  } as unknown as Response;
}

function transportWith(
  status: number,
  body: string,
  headers: Record<string, string> = {},
) {
  const fetchFn = (async () => response(status, body, headers)) as unknown as typeof fetch;
  return createFetchTransport({ fetchFn });
}

describe("http — parseRetryAfterMs", () => {
  it("parses a delta-seconds Retry-After", () => {
    expect(parseRetryAfterMs("5")).toBe(5000);
  });
  it("returns undefined for an absent/garbage header", () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs("soon")).toBeUndefined();
  });
});

describe("http — createFetchTransport", () => {
  it("returns the text body on a 200", async () => {
    const t = transportWith(200, "<ok/>");
    await expect(t.post("https://x", "", {})).resolves.toBe("<ok/>");
  });

  it("classifies 500 as a transient error", async () => {
    const t = transportWith(500, "boom");
    await expect(t.post("https://x", "", {})).rejects.toBeInstanceOf(
      ArcaTransientError,
    );
  });

  it("classifies 429 as transient and honours Retry-After", async () => {
    const t = transportWith(429, "slow down", { "retry-after": "7" });
    const err = await t.post("https://x", "", {}).catch((e) => e);
    expect(err).toBeInstanceOf(ArcaTransientError);
    expect((err as ArcaTransientError).retryAfterMs).toBe(7000);
  });

  it("classifies 401/403 as auth errors", async () => {
    await expect(transportWith(401, "").post("https://x", "", {})).rejects.toBeInstanceOf(
      ArcaAuthError,
    );
    await expect(transportWith(403, "").post("https://x", "", {})).rejects.toBeInstanceOf(
      ArcaAuthError,
    );
  });

  it("classifies other 4xx as permanent business errors", async () => {
    await expect(transportWith(400, "").post("https://x", "", {})).rejects.toBeInstanceOf(
      ArcaBusinessError,
    );
  });

  it("surfaces a SOAP Fault arriving as HTTP 500 (fault body read, not discarded)", async () => {
    const body = `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>soap:Client</faultcode><faultstring>bad request</faultstring></soap:Fault></soap:Body></soap:Envelope>`;
    const t = transportWith(500, body);
    const err = await t.post("https://x", "", {}).catch((e) => e);
    expect(err).toBeInstanceOf(ArcaBusinessError);
    expect((err as ArcaBusinessError).faultstring).toBe("bad request");
  });

  it("surfaces a SOAP Fault arriving as HTTP 200 (not silently mapped to success)", async () => {
    const body = `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>ns2:failedAuthentication</faultcode><faultstring>invalid</faultstring></soap:Fault></soap:Body></soap:Envelope>`;
    const t = transportWith(200, body);
    await expect(t.post("https://x", "", {})).rejects.toBeInstanceOf(ArcaAuthError);
  });

  it("passes through an empty body on 200 without error", async () => {
    await expect(transportWith(200, "").post("https://x", "", {})).resolves.toBe("");
  });

  it("aborts a never-resolving fetch with a typed timeout error", async () => {
    const fetchFn = ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      })) as unknown as typeof fetch;

    const t = createFetchTransport({
      fetchFn,
      timeoutMs: 50,
      abortSignalTimeout: (ms) => AbortSignal.timeout(ms),
    });
    await expect(t.post("https://x", "", {})).rejects.toBeInstanceOf(
      ArcaTransientError,
    );
  });

  it("aborts a hanging response BODY read (body read covered by the timeout)", async () => {
    const fetchFn = (async (_url: unknown, init?: { signal?: AbortSignal }) =>
      response(200, "", {}, () =>
        new Promise<string>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
      )) as unknown as typeof fetch;

    const t = createFetchTransport({
      fetchFn,
      timeoutMs: 50,
      abortSignalTimeout: (ms) => AbortSignal.timeout(ms),
    });
    await expect(t.post("https://x", "", {})).rejects.toBeInstanceOf(
      ArcaTransientError,
    );
  });

  it("has a sane default timeout budget", () => {
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000);
    expect(DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});
