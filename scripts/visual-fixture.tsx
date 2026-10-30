import React from "react";
import { createRoot } from "react-dom/client";
import AppLayout from "../src/app/(app)/layout";
import Home from "../src/app/(app)/page";
import ClientsPage from "../src/app/(app)/clients/page";
import InvoicesPage from "../src/app/(app)/invoices/page";
import CredentialsPage from "../src/app/(app)/credentials/page";
import EmissionPage from "../src/app/(app)/emission/page";
import LookupPage from "../src/app/(app)/cuit-lookup/page";
import ReviewPage from "../src/app/(app)/review/page";
import LoginPage from "../src/app/login/page";
import "../src/app/globals.css";

const pages: Record<string, () => Promise<React.JSX.Element>> = {
  "/": Home,
  "/clients": ClientsPage,
  "/invoices": InvoicesPage,
  "/credentials": CredentialsPage,
  "/emission": EmissionPage,
  "/cuit-lookup": LookupPage,
  "/review": ReviewPage,
};

async function render() {
  const element = document.getElementById("root");
  if (!element) throw new Error("Visual fixture root is missing");
  const route = pages[window.location.pathname];
  const content = window.location.pathname === "/login" ? <LoginPage /> : await AppLayout({ children: await (route ?? Home)() });
  createRoot(element).render(content);
}

void render();
