import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("React", React);
vi.mock("@/lib/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/credentials/service", () => ({ getCredentialInfo: async () => null }));
vi.mock("@/lib/clients/clients", () => ({ listClients: async () => [{ id: "company-1", razonSocial: "Empresa real", cuit: "30710145764", ptoVta: 3, condicionIva: "ri", delegationEnabled: true }] }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import ClientsPage from "./page";

describe("client cards", () => {
  it("presents real fiscal data in cards while preserving management actions", async () => {
    const html = renderToStaticMarkup(await ClientsPage());
    expect(html).toContain('class="surface client-card"');
    expect(html).toContain("Empresa real");
    expect(html).toContain("30710145764");
    expect(html).toContain("0003");
    expect(html).toContain("Responsable inscripto");
    for (const action of ["Desactivar delegación", "Editar", "Consultar puntos de venta en homologación", "Crear cliente"]) expect(html).toContain(action);
    expect(html).not.toContain("Estudio Norte");
  });
});
