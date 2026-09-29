import Link from "next/link";
import type { ReactNode } from "react";
import { auth } from "@/auth";
import LogoutButton from "./logout-button";

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
    <div>
      <nav>
        <Link href="/">Upload</Link>{" "}
        <Link href="/review">Review</Link>{" "}
        <Link href="/invoices">Invoices</Link>{" "}
        <Link href="/clients">Clients</Link>
      </nav>
      <div>
        {email ? <span>{email}</span> : null} <LogoutButton />
      </div>
      {children}
    </div>
  );
}
