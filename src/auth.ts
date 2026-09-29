/**
 * NextAuth v5 configuration (Node runtime) — a single `credentials` provider
 * backed by the `accountant` table (the sole user, per the spec). Session
 * strategy is JWT, which is sufficient for a single user.
 *
 * The credential check is delegated to `verifyAccountantCredentials` (the only
 * code that touches the password hash). The JWT/session callbacks persist the
 * accountant's id; the password hash is never placed on the session.
 *
 * This is the FULL Node-side config (with the DB-backed `authorize`). The
 * edge-safe split lives in `src/auth.config.ts` for the middleware, which must
 * not import `pg`.
 */

import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { getDb } from "@/lib/db/client";
import { verifyAccountantCredentials } from "@/lib/auth/credentials";
import { authConfig } from "@/auth.config";

export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email =
          typeof credentials?.email === "string" ? credentials.email : "";
        const password =
          typeof credentials?.password === "string" ? credentials.password : "";
        if (email.trim() === "" || password === "") {
          return null;
        }
        return verifyAccountantCredentials(getDb(), email, password);
      },
    }),
  ],
});
