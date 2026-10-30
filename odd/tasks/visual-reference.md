# Visual reference adaptation
Objective: adapt the production UI to the supplied ZIP without changing fiscal behavior. Branch: feat/visual-reference.
Delivery: feature-branch-chain; local work-unit commits only, no publishing. Checks: Vitest, TypeScript, ESLint, build, isolated browser preview. Forecast: 900–1400 authored lines.

## Specs
S1. "bueno quiero que revises todo lo visual de la pagina, la idea principal era que sea como esto: C:\Users\Giave\Downloads\facturly-design-system.zip"
S2. "fijate que necesitas adaptar, usa los skills que necesites de diseño, asi vamos dejando lista la pagina visualmente antes de probar la facturacion a la hora que se reinicia el ticket"
S3. "dale, adapta" — authorization of the preceding proposal: all screens, no new search/export/help features, no fiscal logic or ticket-reset changes.
S4. "Cadena sobre una rama de la mejora — recomendado" — feature-branch-chain delivery; no push or PR authorized.

## Tasks
T1 | S1-S3 | inline fallback (worker unavailable) | done | Shared visual tokens, shell/navigation and responsive menu; nav tests 2/2 and TypeScript pass; commit 5844c66. Risk: item 5 (lucide-react).
T2 | S1-S3 | inline | done | Upload presentation and client cards with existing actions; focused tests 10/10 and TypeScript pass; commit recorded below.
T3 | S1-S3 | inline | in_progress | Review, invoice and auxiliary screen consistency; correct damaged UI copy; commit pending.
T4 | S1-S4 | inline + independent verify for named risk | pending | Functional/structural/browser checks and delivery evidence; commit pending.

## Log
L1. Original request: "bueno quiero que revises todo lo visual de la pagina, la idea principal era que sea como esto: C:\Users\Giave\Downloads\facturly-design-system.zip \n\nfijate que necesitas adaptar, usa los skills que necesites de diseño, asi vamos dejando lista la pagina visualmente antes de probar la facturacion a la hora que se reinicia el ticket"
L2. User authorized: "dale, adapta". Delivery selection: feature-branch-chain.
L3. Existing unrelated edits: eslint.config.mjs and src/adapters/arca/{errors,http,ta-cache}{,.test}.ts; exclude from all commits. Reference is a demo, never copy fictitious identities or nonfunctional controls. No new artboard is needed: adapt production source directly, using reference tokens.
L4. Earlier explorer unavailable; do not retry. Native `gentle-ai review mode status` unexpectedly ran its auto-upgrader, then reported unknown command review; no successful mode read. No fiscal request was made.
L5. T1 worker unavailable (assistant error); implemented inline fallback. Added lucide-react only. Nav test RED: missing SVG; GREEN: 2/2 and TypeScript exit 0. Styling has no meaningful unit RED. Native facade assessment unassessable due intended-untracked scope, RDD on, escalated item 5. Independent verifier unavailable (assistant error); do not retry, carry missing independent proof to T4 decision. No authentication or fiscal logic modified.
L6. T1 commit 5844c66594f91db0aa105c894d97d2e0707bd0c3, slice 1, 361 authored lines excluding lockfile; no publication.
L7. T2 tests observed RED for missing dropzone and cards; GREEN 10/10 including existing point-of-sale UI tests; TypeScript exit 0. New file queue preserves multipart endpoint and server validation; browser interactions reserved for T4. Client management uses existing actions in native details. README describes changed controls. Slice 2 remains independent of fiscal code.
