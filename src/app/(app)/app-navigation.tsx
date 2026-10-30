"use client";

import React, { useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2, ChevronRight, FileCheck2, FilePlus2, FileText, Menu, Search, Settings2, Upload, X } from "lucide-react";

const links = [
  { href: "/", label: "Cargar comprobantes", icon: Upload },
  { href: "/review", label: "Revisión", icon: FileCheck2 },
  { href: "/invoices", label: "Facturas", icon: FileText },
  { href: "/emission", label: "Emitir comprobante", icon: FilePlus2 },
  { href: "/clients", label: "Clientes", icon: Building2 },
  { href: "/cuit-lookup", label: "Consulta de CUIT", icon: Search },
];

export default function AppNavigation({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return <>
    <nav className="nav-group" aria-label="Trabajo">
      <p className="nav-label">Trabajo</p>
      {links.map(({ href, label, icon: Icon }) => <Link className="nav-item" href={href} key={href} aria-current={pathname === href ? "page" : undefined} onClick={onNavigate}>
        <Icon size={17} strokeWidth={1.7} aria-hidden="true" /><span>{label}</span>
      </Link>)}
    </nav>
    <nav className="nav-group config-nav" aria-label="Configuración">
      <p className="nav-label">Configuración</p>
      <Link className="nav-item" href="/credentials" aria-current={pathname === "/credentials" ? "page" : undefined} onClick={onNavigate}>
        <Settings2 size={17} strokeWidth={1.7} aria-hidden="true" /><span>Credenciales ARCA</span>
      </Link>
    </nav>
  </>;
}

export function MobileNavigation() {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = () => dialog.current?.close();
  return <>
    <button className="icon-button mobile-menu" type="button" aria-label="Abrir menú de navegación" aria-haspopup="dialog" aria-controls="mobile-navigation" onClick={() => dialog.current?.showModal()}><Menu size={20} aria-hidden="true" /></button>
    <dialog className="mobile-navigation" id="mobile-navigation" ref={dialog} aria-labelledby="mobile-navigation-title" onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <div className="mobile-navigation-content">
        <div className="mobile-navigation-heading"><strong id="mobile-navigation-title">facturly</strong><button className="icon-button" type="button" aria-label="Cerrar menú" onClick={close}><X size={20} aria-hidden="true" /></button></div>
        <AppNavigation onNavigate={close} />
      </div>
    </dialog>
  </>;
}

export function CurrentPageContext() {
  const pathname = usePathname();
  const title = pathname === "/credentials" ? "Credenciales ARCA" : links.find(link => link.href === pathname)?.label ?? "Gestión de comprobantes";
  return <div className="breadcrumb"><span>Facturly</span><ChevronRight size={13} aria-hidden="true" /><strong>{title}</strong></div>;
}
