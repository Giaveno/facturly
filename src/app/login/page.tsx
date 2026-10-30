"use client";

import { useState, type FormEvent } from "react";
import { signIn } from "next-auth/react";
import { ShieldCheck } from "lucide-react";

/**
 * Email and password login through NextAuth credentials provider.
 */
export default function LoginPage() {
  const [error, setError] = useState<string>("");
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setPending(true);

    const form = new FormData(e.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");

    try {
      const result = await signIn("credentials", { email, password, redirect: false });
      if (result?.error) {
        setError("El correo o la contraseña no son correctos.");
        setPending(false);
        return;
      }
    } catch {
      setError("No se pudo iniciar sesión. Revisá tu conexión e intentá nuevamente.");
      setPending(false);
      return;
    }
    // Full navigation so the middleware re-evaluates the now-authenticated
    // session cookie.
    window.location.href = "/";
  }

  return (
    <main className="auth-page">
      <section className="surface auth-card">
      <div className="brand" aria-label="Facturly"><span className="brand-mark" aria-hidden="true">F</span>facturly<span className="brand-dot">.</span></div>
      <p className="eyebrow">Tu espacio de trabajo</p>
      <h1>Iniciar sesión</h1>
      <p>Ingresá a tu espacio de trabajo para gestionar comprobantes.</p>
      <form className="auth-form" onSubmit={onSubmit}>
        <label>
          Correo electrónico
          <input name="email" type="email" required autoComplete="email" />
        </label>
        <label>
          Contraseña
          <input
            name="password"
            type="password"
            required
            autoComplete="current-password"
          />
        </label>
        <button type="submit" disabled={pending}>
          {pending ? "Ingresando…" : "Iniciar sesión"}
        </button>
      </form>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <p className="auth-note"><ShieldCheck size={13} aria-hidden="true" /> Acceso seguro a tus comprobantes</p>
      </section>
    </main>
  );
}
