import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import ClientActions from "./client-actions";
import ClientsForm from "./clients-form";
import { PointsOfSaleResult } from "./points-of-sale-action";
const client = { id: "client", cuit: "30710145764", ptoVta: 12345, razonSocial: "TEST", condicionIva: "ri" };
it("provides a separate explicit query and no-emission/fiscal-readiness disclaimer", () => {
  const html = renderToStaticMarkup(createElement(ClientActions, { clientId: client.id, ...client, delegationEnabled: false, fingerprint: "a".repeat(64), homologationEnabled: true }));
  expect(html).toContain("Consultar puntos de venta en homologación"); expect(html).toContain("no emite"); expect(html).toContain("no crea ni modifica"); expect(html).toContain("no confirma");
  expect(renderToStaticMarkup(createElement(ClientsForm))).toContain('max="99998"');
});
it.each(["available_cae", "not_returned", "not_available_cae", "unverified"] as const)("truthfully renders configured %s and all full point numbers", configuredPoint => {
  const html = renderToStaticMarkup(createElement(PointsOfSaleResult, { report: { environment: "homologacion", client, fingerprint: "a".repeat(64), checkedAt: "2026-10-28T12:00:00Z", configuredPoint, points: [{ number: 12345, status: "blocked", emissionType: "CAEA", blocked: true, deregisteredOn: null }, { number: 99998, status: "deregistered", emissionType: "CAE", blocked: false, deregisteredOn: "2026-10-28" }, { number: 3, status: "unknown", emissionType: "unknown", blocked: null, deregisteredOn: null }] } }));
  expect(html).toContain("12345"); expect(html).toContain("99998"); expect(html).toContain("Bloqueado"); expect(html).toContain("2026-10-28"); expect(html).toContain("CAEA"); expect(html).toContain("Sin verificar");
  expect(html).not.toMatch(/listo para facturar|SECRET|PRIVATE/);
});
it("explains empty records without silently accepting configured PV", () => {
  const html = renderToStaticMarkup(createElement(PointsOfSaleResult, { report: { environment: "homologacion", client, fingerprint: "a".repeat(64), checkedAt: "2026-10-28T12:00:00Z", configuredPoint: "not_returned", points: [] } }));
  expect(html).toContain("no devolvió puntos de venta"); expect(html).toContain("no aparece");
});
it("shows blocking and deregistration fields explicitly, including unknown values", () => {
  const html = renderToStaticMarkup(createElement(PointsOfSaleResult, { report: {
    environment: "homologacion", client, fingerprint: "a".repeat(64), checkedAt: "2026-10-28T12:00:00Z", configuredPoint: "unverified",
    points: [
      { number: 1, status: "available", emissionType: "CAE", blocked: false, deregisteredOn: null },
      { number: 2, status: "blocked", emissionType: "CAEA", blocked: true, deregisteredOn: null },
      { number: 3, status: "unknown", emissionType: "unknown", blocked: null, deregisteredOn: null },
    ],
  } }));
  expect(html).toContain("Bloqueado: N");
  expect(html).toContain("Bloqueado: S");
  expect(html).toContain("Bloqueado: sin verificar");
  expect(html).toContain("Baja: sin fecha verificada");
});
