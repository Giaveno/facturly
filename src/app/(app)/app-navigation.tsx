"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  ["/", "Cargar comprobantes"],
  ["/review", "Revisión"],
  ["/invoices", "Facturas"],
  ["/emission", "Emitir comprobante"],
  ["/clients", "Clientes"],
  ["/cuit-lookup", "Consulta de CUIT"],
] as const;
const titles: Record<string, string> = {
  "/": "Cargar comprobantes",
  "/review": "Revisión",
  "/invoices": "Facturas",
  "/emission": "Emitir comprobante",
  "/clients": "Clientes",
  "/cuit-lookup": "Consulta de CUIT",
  "/credentials": "Credenciales ARCA",
};

export default function AppNavigation() {
  const pathname = usePathname();
  return (
    <>
      <nav className="nav-group" aria-label="Trabajo">
        <p className="nav-label">Trabajo</p>
        {links.map(([href, label]) => (
          <Link className="nav-item" href={href} key={href} aria-current={pathname === href ? "page" : undefined}>
            {label}
          </Link>
        ))}
      </nav>
      <nav className="nav-group config-nav" aria-label="Configuración">
        <p className="nav-label">Configuración</p>
        <Link className="nav-item" href="/credentials" aria-current={pathname === "/credentials" ? "page" : undefined}>
          Credenciales ARCA
        </Link>
      </nav>
    </>
  );
}

export function CurrentPageContext() {
  const pathname = usePathname();
  return <div className="breadcrumb"><span>Facturly</span><span aria-hidden="true"> / </span><strong>{titles[pathname] ?? "Gestión de comprobantes"}</strong></div>;
}
