import { describe, expect, it, vi } from "vitest";
import { ArcaGatewayProd } from "./arca-gateway.prod";
import { ArcaAuthError, ArcaBusinessError } from "./errors";
import { WsfeClient, type WsfeTransport } from "./wsfe";
import { PadronA5Client } from "./padron";

describe("ultimo gateway retries and side effects", () => {
  const setup = (codes: string[]) => {
    const taCache = { get: vi.fn(async () => ({ token: "SECRET_TOKEN", sign: "SECRET_SIGN", expirationTime: "2026-10-29T00:00:00Z" })), evict: vi.fn(async () => {}) };
    const post = vi.fn<WsfeTransport["post"]>(async () => {
      const code = codes.shift();
      return `<Envelope><Body><FECompUltimoAutorizadoResponse><FECompUltimoAutorizadoResult>${code ? `<Errors><Err><Code>${code}</Code><Msg>SECRET</Msg></Err></Errors>` : "<CbteNro>0</CbteNro>"}</FECompUltimoAutorizadoResult></FECompUltimoAutorizadoResponse></Body></Envelope>`;
    });
    const gateway = new ArcaGatewayProd({ taCache, wsfe: new WsfeClient({ url: "https://offline.invalid", transport: { post } }), padron: {} as PadronA5Client, emissionsEnabled: true });
    return { gateway, post, taCache };
  };
  it("refreshes token once then accepts explicit first-invoice zero", async () => {
    const { gateway, post, taCache } = setup(["600"]);
    expect(await gateway.ultimoAutorizado("20123456789", 1, 11)).toBe(0);
    expect(taCache.evict).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls.every(([, body, headers]) => body.includes("<ar:FECompUltimoAutorizado>") && !body.includes("FECAESolicitar") && headers.SOAPAction === '"http://ar.gov.afip.dif.FEV1/FECompUltimoAutorizado"')).toBe(true);
  });
  it("does not retry a token rejection more than once", async () => {
    const { gateway, post, taCache } = setup(["600", "600", "600"]);
    await expect(gateway.ultimoAutorizado("20123456789", 1, 11)).rejects.toBeInstanceOf(ArcaAuthError);
    expect(post).toHaveBeenCalledTimes(2);
    expect(taCache.evict).toHaveBeenCalledTimes(1);
  });
  it.each(["601", "602", "11002"])("does not refresh permission/no-data/business code %s", async code => {
    const { gateway, post, taCache } = setup([code]);
    await expect(gateway.ultimoAutorizado("20123456789", 1, 11)).rejects.toBeInstanceOf(ArcaBusinessError);
    expect(post).toHaveBeenCalledTimes(1);
    expect(taCache.evict).not.toHaveBeenCalled();
  });
});
