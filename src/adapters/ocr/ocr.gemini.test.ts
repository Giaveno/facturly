import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfiguredOcrProvider, GeminiOcrProvider } from "./ocr.gemini";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0x01]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const MODEL_JSON = JSON.stringify({
  name: "Comprobante de prueba",
  amount: "1234.56",
  date: "2026-09-22",
  cuit: "23000000809",
  cbu: null,
  cvu: null,
  alias: null,
  opNumber: null,
  uncertainFields: [],
});

function response(text: string, status = 200) {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status });
}

describe("Gemini OCR adapter (mocked REST only)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends an explicitly opted-in image with API key header and constrained schema", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(MODEL_JSON));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new GeminiOcrProvider({ apiKey: "FAKE_TEST_KEY_NOT_A_SECRET", fetchImpl: fetchMock });
    await provider.extract(JPEG);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("models/gemini-3.1-flash-lite:generateContent");
    expect(url).not.toContain("FAKE_TEST_KEY_NOT_A_SECRET");
    expect(new Headers(init.headers).get("x-goog-api-key")).toBe("FAKE_TEST_KEY_NOT_A_SECRET");
    const body = JSON.parse(String(init.body));
    expect(body.contents[0].parts[1].inlineData.mimeType).toBe("image/jpeg");
    expect(body.contents[0].parts[1].inlineData.data).toBe(Buffer.from(JPEG).toString("base64"));
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema.required).toContain("uncertainFields");
    expect(body.generationConfig.maxOutputTokens).toBeLessThanOrEqual(1024);
  });

  it.each([[JPEG, "image/jpeg"], [PNG, "image/png"], [WEBP, "image/webp"]] as const)("maps image bytes to %s", async (bytes, mimeType) => {
    const fetchMock = vi.fn().mockResolvedValue(response(MODEL_JSON));
    const provider = new GeminiOcrProvider({ apiKey: "FAKE_TEST_KEY_NOT_A_SECRET", fetchImpl: fetchMock });
    await provider.extract(bytes);
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.contents[0].parts[1].inlineData.mimeType).toBe(mimeType);
  });

  it("returns normalized fields and conservative confidence, never self-asserted confidence", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(MODEL_JSON));
    const result = await new GeminiOcrProvider({ apiKey: "FAKE_TEST_KEY_NOT_A_SECRET", fetchImpl: fetchMock }).extract(JPEG);
    expect(result.fields).toEqual({ name: "Comprobante de prueba", amount: 123456, date: "2026-09-22" });
    expect(result.cuit).toBe("23000000809");
    expect(result.confidence.name).toBeLessThan(0.8);
  });

  it("preserves null missing values and marks uncertain fields blocked", async () => {
    const output = JSON.parse(MODEL_JSON) as Record<string, unknown>;
    output.cuit = null;
    output.cbu = null;
    output.uncertainFields = ["amount"];
    const fetchMock = vi.fn().mockResolvedValue(response(JSON.stringify(output)));
    const result = await new GeminiOcrProvider({ apiKey: "FAKE_TEST_KEY_NOT_A_SECRET", fetchImpl: fetchMock }).extract(JPEG);
    expect(result.cuit).toBeUndefined();
    expect(result.fields.cbu).toBeUndefined();
    expect(result.confidence.amount).toBe(0);
  });

  it("rejects absent key, invalid image and malformed model data without an external call", async () => {
    const fetchMock = vi.fn();
    await expect(new GeminiOcrProvider({ apiKey: "", fetchImpl: fetchMock }).extract(JPEG)).rejects.toThrow("not configured");
    await expect(new GeminiOcrProvider({ apiKey: "FAKE_TEST_KEY_NOT_A_SECRET", fetchImpl: fetchMock }).extract(new Uint8Array([1]))).rejects.toThrow("Unsupported image");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the default provider offline unless explicitly opted in", async () => {
    const provider = createConfiguredOcrProvider({});
    await expect(provider.extract(JPEG)).rejects.toThrow("not configured");
    const optIn = createConfiguredOcrProvider({ OCR_PROVIDER: "gemini", GEMINI_API_KEY: "FAKE_TEST_KEY_NOT_A_SECRET" });
    expect(optIn).toBeInstanceOf(GeminiOcrProvider);
  });

  it("rejects malformed JSON and invalid dates/amounts rather than guessing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response("not json"));
    const provider = new GeminiOcrProvider({ apiKey: "FAKE_TEST_KEY_NOT_A_SECRET", fetchImpl: fetchMock });
    await expect(provider.extract(JPEG)).rejects.toThrow("invalid response");
    fetchMock.mockResolvedValue(response(JSON.stringify({ name: "X", amount: "NaN", date: "2026-02-31", cuit: null, cbu: null, cvu: null, alias: null, opNumber: null, uncertainFields: [] })));
    await expect(provider.extract(JPEG)).rejects.toThrow("invalid response");
  });

  it("sanitizes HTTP errors and handles rate limits without leaking response/key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("FAKE_TEST_KEY_NOT_A_SECRET private payload", { status: 429 }));
    const provider = new GeminiOcrProvider({ apiKey: "FAKE_TEST_KEY_NOT_A_SECRET", fetchImpl: fetchMock });
    await expect(provider.extract(JPEG)).rejects.toThrow("rate limited");
    fetchMock.mockResolvedValue(new Response("secret body", { status: 500 }));
    await expect(provider.extract(JPEG)).rejects.toThrow("request failed");
    fetchMock.mockResolvedValue(response("x".repeat(16_385)));
    await expect(provider.extract(JPEG)).rejects.toThrow("invalid response");
  });

  it("reports safe HTTP status and allowlisted provider diagnostics only", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { code: 403, status: "PERMISSION_DENIED", message: "private detail with API key" },
    }), { status: 403 }));
    const provider = new GeminiOcrProvider({ apiKey: "FAKE_TEST_KEY_NOT_A_SECRET", fetchImpl: fetchMock });
    let message = "";
    try { await provider.extract(JPEG); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("403");
    expect(message).toContain("PERMISSION_DENIED");
    expect(message).not.toContain("private detail");
    expect(message).not.toContain("FAKE_TEST_KEY_NOT_A_SECRET");
    expect(message).not.toContain("secret");
  });

  it("does not expose arbitrary provider diagnostic strings", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { code: 500, status: "attacker-controlled detail", message: "secret body" },
    }), { status: 500 }));
    const provider = new GeminiOcrProvider({ apiKey: "FAKE_TEST_KEY_NOT_A_SECRET", fetchImpl: fetchMock });
    await expect(provider.extract(JPEG)).rejects.toThrow("HTTP 500");
    await expect(provider.extract(JPEG)).rejects.not.toThrow("attacker-controlled");
  });

  it("labels network failures stably without echoing the exception", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("private network detail"));
    const provider = new GeminiOcrProvider({ apiKey: "FAKE_TEST_KEY_NOT_A_SECRET", fetchImpl: fetchMock });
    await expect(provider.extract(JPEG)).rejects.toThrow("Gemini OCR network failure");
    await expect(provider.extract(JPEG)).rejects.not.toThrow("private network detail");
  });

  it("rejects oversized declared response bodies before parsing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", {
      status: 200,
      headers: { "content-length": "65537" },
    }));
    const provider = new GeminiOcrProvider({ apiKey: "FAKE_TEST_KEY_NOT_A_SECRET", fetchImpl: fetchMock });
    await expect(provider.extract(JPEG)).rejects.toThrow("response too large");
  });

  it("cancels streamed response bodies once they exceed the byte cap", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65_537).fill(0x20));
      },
      cancel() { cancelled = true; },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, { status: 200 }));
    const provider = new GeminiOcrProvider({ apiKey: "FAKE_TEST_KEY_NOT_A_SECRET", fetchImpl: fetchMock });
    await expect(provider.extract(JPEG)).rejects.toThrow("response too large");
    expect(cancelled).toBe(true);
  });

  it("uses a bounded timeout", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const provider = new GeminiOcrProvider({ apiKey: "FAKE_TEST_KEY_NOT_A_SECRET", fetchImpl: fetchMock, timeoutMs: 5 });
    await expect(provider.extract(JPEG)).rejects.toThrow("timed out");
  });

  it("allows up to 60 seconds for the default Gemini request", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }));
      const result = new GeminiOcrProvider({ apiKey: "FAKE_TEST_KEY_NOT_A_SECRET", fetchImpl: fetchMock }).extract(JPEG);
      const rejection = expect(result).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(59_999);
      expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});

