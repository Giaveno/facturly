import Link from "next/link";
import type { ReactNode } from "react";
import { ShieldCheck } from "lucide-react";
import { auth } from "@/auth";
import LogoutButton from "./logout-button";
import AppNavigation, { CurrentPageContext, MobileNavigation } from "./app-navigation";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  const email = session?.user?.email ?? "";
  const initials = email.slice(0, 2).toLocaleUpperCase("es-AR") || "F";
  const environment = process.env.ARCA_ENV === "production" ? "Producción" : process.env.ARCA_ENV === "homologacion" ? "Homologación" : "Entorno no configurado";

  return <div className="app-shell">
    <a className="skip-link" href="#workspace-content">Ir al contenido</a>
    <aside className="sidebar">
      <Link className="brand" href="/" aria-label="Facturly, inicio"><span className="brand-mark" aria-hidden="true">F</span>facturly<span className="brand-dot">.</span></Link>
      <div className="workspace-identity"><span className="workspace-icon"><ShieldCheck size={18} aria-hidden="true" /></span><div><strong>Espacio de trabajo</strong><small>Gestión de comprobantes</small></div></div>
      <AppNavigation />
      <div className="sidebar-footer"><div className="user-profile"><span className="user-avatar" aria-hidden="true">{initials}</span><div><strong>Tu cuenta</strong><small>{email || "Sesión iniciada"}</small></div></div><LogoutButton /></div>
    </aside>
    <div className="app-main">
      <header className="topbar"><div className="topbar-context"><MobileNavigation /><CurrentPageContext /></div><div className="topbar-actions"><span className={`environment ${process.env.ARCA_ENV === "production" ? "environment-production" : ""}`}><span aria-hidden="true" />{environment}</span><span className="topbar-user" aria-label={email ? `Cuenta: ${email}` : "Cuenta activa"}>{initials}</span></div></header>
      <div id="workspace-content" tabIndex={-1}>{children}</div>
    </div>
  </div>;
}
