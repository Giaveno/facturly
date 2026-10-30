# facturas-arca

Automates ARCA (ex-AFIP) invoicing for a single accountant: receipt photos in →
OCR → review → comprobante (Factura A/B/C) → `FECAESolicitar` → CAE → PDF + Excel.

A hexagonal TypeScript monolith (Next.js 15 + React 19 + Drizzle + Neon Postgres +
Inngest), fully testable offline (Vitest + PGlite + fake adapters). The whole
flow runs end-to-end with **no credentials and no network** via `pnpm demo`.

## Commands

| Command                 | What it does                                              |
| ----------------------- | --------------------------------------------------------- |
| `pnpm dev`              | Start the Next.js dev server                              |
| `pnpm build`            | Production build (also type-checks)                       |
| `pnpm test`             | Run the offline unit/integration suite (Vitest + PGlite)  |
| `pnpm test:watch`       | Same, watch mode                                          |
| `pnpm test:e2e`         | Playwright end-to-end suite                               |
| `pnpm demo`             | Offline demo of the full flow (`pnpm demo --debug` for raw QR) |
| `pnpm typecheck`        | `tsc --noEmit`                                            |
| `pnpm lint`             | ESLint                                                    |
| `pnpm db:generate`      | Emit a new Drizzle migration from the schema              |
| `pnpm db:migrate`       | Apply pending migrations to `DATABASE_URL`                |
| `pnpm db:push`          | Push the schema directly (dev only)                       |
| `pnpm db:seed`          | Create/update the single accountant from env vars         |
| `pnpm homologacion:spike` | Manual pre-apply gate vs ARCA homologación (needs creds) |

## Demo mode (offline) — env vars

`pnpm demo` boots the offline stack by selecting drivers via env vars. **Every
non-default value below is TEST/DEMO ONLY and is refused at startup when
`NODE_ENV=production`** — it is structurally impossible to run the fake stack or
test auth in a production build. Defaults are always the safe production values.

| Variable          | Safe default | Demo/test value | Meaning                              |
| ----------------- | ------------ | --------------- | ------------------------------------ |
| `DATABASE_DRIVER` | `pg`         | `pglite`        | Neon Postgres vs in-process Postgres |
| `ARCA_ADAPTER`    | `prod`       | `fake`          | Real WSAA/WSFEv1 vs in-memory fake   |
| `OCR_ADAPTER`     | `prod`       | `fake`          | (not wired yet) vs in-memory fake    |
| `AUTH_MODE`       | `real`       | `test`          | Fail-closed deny-all vs stub session |

## Authentication (single accountant)

Login uses NextAuth v5 (credentials provider) against the `accountant` table.

1. Set `AUTH_SECRET` (required in production — no fallback): `openssl rand -base64 32`.
2. Seed the accountant:
   ```bash
   ACCOUNTANT_EMAIL=contador@example.com \
   ACCOUNTANT_PASSWORD='a-strong-password' \
   pnpm db:seed
   ```
3. `pnpm dev`, then open `/login` and sign in. The password is bcrypt-hashed
   (never stored or logged in plaintext).

The app shell (Upload / Review / Invoices / Clients) and the app API routes are
protected by `src/middleware.ts`; unauthenticated page requests redirect to
`/login`, unauthenticated API requests get a 401. NextAuth's own routes
(`/api/auth`) and the Inngest endpoint (`/api/inngest`) are exempt.

## Workspace interface

- Upload: choose the issuing company, drag images into the upload area or use **Elegir archivos**, then review the selected filenames before uploading. Remove individual files or clear the selection before submitting. The server enforces JPG/PNG/WebP, 10 images, 10 MiB per image and the total request limit.
- Clients: open **Registrar nueva empresa** to add an issuer. Each company card exposes its existing editing, delegation and point-of-sale controls under **Administrar empresa**.
- On mobile, open the navigation menu from the top bar; Escape or the close button dismisses it. The top bar displays the configured fiscal environment, not a simulated status.
- Visual changes do not combine review confirmation with fiscal approval. No invoice is emitted by selecting files, opening cards or navigating.

For isolated UI verification, run `node scripts/verify-visual.mjs` after installing Playwright's Chromium browser. The script serves the production page components on `127.0.0.1:4179` with synthetic data, replaces authentication/database dependencies in the preview bundle only, intercepts API requests and blocks external network traffic. It checks desktop/tablet/mobile layouts and upload/review interactions, then closes its server. Screenshots go to `.data/visual-review/`. This is not a live authentication, database or fiscal integration test.

## Inngest (background jobs)

The emission, OCR, and lost-CAE recovery jobs are served at `/api/inngest`.
That endpoint verifies Inngest webhook signatures, so it needs
`INNGEST_SIGNING_KEY` (from the Inngest dashboard) in the environment.

- **`INNGEST_SIGNING_KEY` is REQUIRED in production** — the app refuses to start
  without it.
- **`INNGEST_DEV` must NEVER be set in production.** It switches Inngest into dev
  mode and disables signature verification entirely, which would let the emission
  (real invoices) and OCR endpoints execute unverified webhooks. It is refused at
  startup when `NODE_ENV=production`.
