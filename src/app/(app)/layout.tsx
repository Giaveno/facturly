import Link from "next/link";
import type { ReactNode } from "react";
import { auth } from "@/auth";
import LogoutButton from "./logout-button";
import AppNavigation, { CurrentPageContext } from "./app-navigation";

/**
 * Authenticated app shell — navigation between Upload, Review, Invoices (and a
 * placeholder Clients link), plus the logged-in accountant's email and a logout
 * button. Deliberately plain — no design work.
 */
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  const email = session?.user?.email ?? "";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand" href="/" aria-label="Facturly, inicio">
          <span className="brand-mark" aria-hidden="true">F</span> facturly
        </Link>
        <AppNavigation />
        <div className="sidebar-footer">
          {email ? <p>{email}</p> : null}
          <LogoutButton />
        </div>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <CurrentPageContext />
          <div className="topbar-actions">Acceso seguro</div>
        </header>
        {children}
      </div>
    </div>
  );
}
