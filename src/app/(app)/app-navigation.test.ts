import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/review" }));
import AppNavigation, { CurrentPageContext } from "./app-navigation";

describe("workspace navigation", () => {
  it("preserves every real destination and the current page", () => {
    const html = renderToStaticMarkup(createElement(AppNavigation));
    for (const href of ["/", "/review", "/invoices", "/emission", "/clients", "/cuit-lookup", "/credentials"]) {
      expect(html).toContain(`href="${href}"`);
    }
    expect(html).toMatch(/<a(?=[^>]*href="\/review")(?=[^>]*aria-current="page")[^>]*>/);
    expect(renderToStaticMarkup(createElement(CurrentPageContext))).toContain("Revisión");
  });

  it("provides decorative icons without inventing unavailable actions", () => {
    const html = renderToStaticMarkup(createElement(AppNavigation));
    expect(html).toContain("<svg");
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("Ayuda");
    expect(html).not.toContain("Estudio Norte");
  });
});
