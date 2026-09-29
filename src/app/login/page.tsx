"use client";

import { useState, type FormEvent } from "react";
import { signIn } from "next-auth/react";

/**
 * Minimal login form (email + password) posting to NextAuth's credentials
 * provider. No styling. Shows a clear error on bad credentials.
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

    const result = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });

    if (result?.error) {
      setError("Invalid email or password");
      setPending(false);
      return;
    }
    // Full navigation so the middleware re-evaluates the now-authenticated
    // session cookie.
    window.location.href = "/";
  }

  return (
    <main>
      <h1>Sign in</h1>
      <form onSubmit={onSubmit}>
        <label>
          Email
          <input name="email" type="email" required autoComplete="email" />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            required
            autoComplete="current-password"
          />
        </label>
        <button type="submit" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
      {error ? <p role="alert">{error}</p> : null}
    </main>
  );
}
