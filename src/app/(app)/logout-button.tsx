"use client";

import { signOut } from "next-auth/react";

/** Logout button — signs out and returns to the login page. */
export default function LogoutButton() {
  return (
    <button type="button" onClick={() => signOut({ callbackUrl: "/login" })}>
      Log out
    </button>
  );
}
