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
