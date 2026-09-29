/**
 * Session middleware — protects the authenticated pages (`/`, `/review`,
 * `/invoices`, `/clients`) and the app API routes, EXCEPT NextAuth's own routes
 * (`/api/auth`, excluded in the matcher) and the Inngest endpoint
 * (`/api/inngest`, exempted in the policy). Unauthenticated page requests are
 * redirected to `/login`; unauthenticated API requests get a 401 (never a
 * redirect).
 *
 * Edge-safe: this consumes `auth.config.ts` (no `pg`), NOT the Node-side
 * `auth.ts`, so the middleware bundle runs on the Edge runtime.
 */

import { NextResponse } from "next/server";
import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";
import { decideAuthResponse, isExemptPath } from "@/lib/auth/middleware-policy";

export default NextAuth(authConfig).auth((req) => {
  const { pathname } = req.nextUrl;

  if (isExemptPath(pathname)) {
    return NextResponse.next();
  }

  const decision = decideAuthResponse({
    isLoggedIn: Boolean(req.auth?.user),
    pathname,
  });

  if (decision.kind === "redirect") {
    return NextResponse.redirect(new URL(decision.to, req.nextUrl));
  }
  if (decision.kind === "unauthorized") {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  return NextResponse.next();
});

export const config = {
  // Exclude NextAuth's own routes (exact/segment — NOT `/api/authz`), static
  // assets, and favicon. MUST stay consistent with `isExemptPath` (see the
  // agreement test in `src/middleware.test.ts`, which reads this literal and
  // asserts it never skips a path the policy would protect).
  matcher: ["/((?!api/auth(?:/|$)|_next/static|_next/image|favicon.ico).*)"],
};
