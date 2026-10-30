"use client";

import React from "react";
import { signOut } from "next-auth/react";
import { LogOut } from "lucide-react";

export default function LogoutButton() {
  return <button className="logout-button" type="button" onClick={() => signOut({ callbackUrl: "/login" })}><LogOut size={15} aria-hidden="true" />Cerrar sesión</button>;
}
