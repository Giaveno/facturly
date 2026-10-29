import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import CredentialsForm from "./credentials-form";
it("offers an explicit safe homologation retry and explains authentication is not fiscal readiness", () => {
  const html = renderToStaticMarkup(createElement(CredentialsForm, { initialCertificate: { fingerprint: "a".repeat(64), subjectCn: "TEST", cuit: null, notBefore: "2026", notAfter: "2027" } }));
  expect(html).toContain("Probar conexión en homologación"); expect(html).toContain("punto de venta"); expect(html).toContain("emisor"); expect(html).toContain("no emite");
  expect(html).not.toContain("listo para facturar"); expect(html).not.toContain("BEGIN PRIVATE");
});
