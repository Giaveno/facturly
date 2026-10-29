"use client";

import { signOut } from "next-auth/react";

/** Signs out and returns to the login page. */
export default function LogoutButton() {
  return (
    <button type="button" onClick={() => signOut({ callbackUrl: "/login" })}>
      Cerrar sesión
    </button>
  );
}
