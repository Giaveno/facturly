/**
 * Edge-safe NextAuth configuration — consumed by the session middleware, which
 * runs on the EDGE runtime where Node-only drivers (`pg`) cannot load. This file
 * deliberately imports NO database code (no `getDb`, no `pg`, no `bcryptjs`).
 *
 * The Credentials provider lives in `src/auth.ts` (the Node-side config used by
 * the route handlers and the `requireAccountantSession` seam), because its
 * `authorize` needs the DB. `providers: []` here is intentional: the middleware
 * only needs the JWT/session callbacks to decide "is there a user?" — it never
 * runs `authorize`.
 *
 * This split follows NextAuth v5's documented Edge pattern (auth.config.ts for
 * the middleware, auth.ts for Node handlers) so the middleware bundle no longer
 * transitively imports `pg` (which previously produced the build warning
 * `Module not found: Can't resolve 'pg-native'`).
 */

import type { NextAuthConfig } from "next-auth";

export const authConfig = {
  pages: {
    signIn: "/login",
  },
  session: {
    strategy: "jwt",
  },
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.id = user.id;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
      }
      return session;
    },
  },
  providers: [],
} satisfies NextAuthConfig;
