import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import UploadForm from "./upload-form";

const client = { id: "company-1", razonSocial: "Empresa real", cuit: "30710145764" };

describe("receipt upload presentation", () => {
  it("offers the reference drop area and the real supported formats", () => {
    const html = renderToStaticMarkup(createElement(UploadForm, { clients: [client] }));
    expect(html).toContain("Arrastrá tus comprobantes acá");
    expect(html).toContain('accept="image/jpeg,image/png,image/webp"');
    expect(html).toContain('name="clientId"');
    expect(html).toContain(client.razonSocial);
    expect(html).toContain("JPG, PNG y WebP");
    expect(html).toContain("Nada se emite sin tu aprobación");
  });

  it("preserves the empty-company block and the OCR privacy warning", () => {
    const html = renderToStaticMarkup(createElement(UploadForm, { clients: [] }));
    expect(html).toContain('href="/clients"');
    expect(html).toMatch(/<button(?=[^>]*type="submit")(?=[^>]*disabled)[^>]*>/);
    expect(html).toContain("las imágenes se envían a Google");
    expect(html).not.toContain("ticket_00482");
  });
});
