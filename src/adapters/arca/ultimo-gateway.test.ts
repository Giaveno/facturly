import { describe, expect, it, vi } from "vitest";
import { ArcaGatewayProd } from "./arca-gateway.prod";
import { ArcaAuthError, ArcaBusinessError } from "./errors";
import { WsfeClient, type WsfeTransport } from "./wsfe";
import { PadronA5Client } from "./padron";

describe("ultimo gateway authentication preservation", () => {
  const setup = (codes: string[]) => {
    const taCache = { get: vi.fn(async () => ({ token: "SECRET_TOKEN", sign: "SECRET_SIGN", expirationTime: "2026-10-29T00:00:00Z" })), evict: vi.fn(async () => {}) };
    const post = vi.fn<WsfeTransport["post"]>(async () => {
      const code = codes.shift();
      return `<Envelope><Body><FECompUltimoAutorizadoResponse><FECompUltimoAutorizadoResult>${code ? `<Errors><Err><Code>${code}</Code><Msg>SECRET</Msg></Err></Errors>` : "<CbteNro>0</CbteNro>"}</FECompUltimoAutorizadoResult></FECompUltimoAutorizadoResponse></Body></Envelope>`;
    });
    const gateway = new ArcaGatewayProd({ taCache, wsfe: new WsfeClient({ url: "https://offline.invalid", transport: { post } }), padron: {} as PadronA5Client, emissionsEnabled: true });
    return { gateway, post, taCache };
  };
  it("accepts explicit first-invoice zero without refreshing", async () => {
    const { gateway, post, taCache } = setup([]);
    expect(await gateway.ultimoAutorizado("20123456789", 1, 11)).toBe(0);
    expect(taCache.evict).not.toHaveBeenCalled(); expect(post).toHaveBeenCalledTimes(1);
  });
  it("preserves the cached token and never retries an auth rejection", async () => {
    const { gateway, post, taCache } = setup(["600", "600"]);
    await expect(gateway.ultimoAutorizado("20123456789", 1, 11)).rejects.toBeInstanceOf(ArcaAuthError);
    expect(post).toHaveBeenCalledTimes(1); expect(taCache.get).toHaveBeenCalledTimes(1);
    expect(taCache.evict).not.toHaveBeenCalled();
  });
  it.each(["601", "602", "11002"])("does not refresh permission/no-data/business code %s", async code => {
    const { gateway, post, taCache } = setup([code]);
    await expect(gateway.ultimoAutorizado("20123456789", 1, 11)).rejects.toBeInstanceOf(ArcaBusinessError);
    expect(post).toHaveBeenCalledTimes(1);
    expect(taCache.evict).not.toHaveBeenCalled();
  });
});
