# Diagnose homologacion without accidental issuance

Use the new **preflight first** harness. It never changes issuer configuration,
production settings, emission switches, workers, existing reservations or cached
TA rows. This is a homologacion technical test using the existing certificate's
own CUIT and an **exento** client; it does not establish the user's real tax status.

## Read-only quick path

From the repository root, with the existing `.env` configured **exactly** as
`ARCA_ENV=homologacion`, select the existing client's UUID:

```powershell
pnpm exec tsx scripts/homologacion-diagnostic.ts --client-id EXISTING_CLIENT_UUID --preflight --debug-soap
```

`--preflight` is the default. `--debug-soap` is optional and explicit: console
output contains bounded, redacted request/response XML, including exact provider
codes/messages and faults after redaction. **Never redirect raw SOAP, authentication
responses, certificates, private keys, Token or Sign to files, screenshots or logs.**
Successful authentication responses are never captured. For an opted-in
homologacion SOAP fault, only bounded/redacted `faultcode`, `faultstring` and safe
HTTP classifications are emitted as JSON: never the response XML, fault detail,
`loginCmsReturn`, Token or Sign. Malformed XML, DTD/entities and
oversized documents produce an omission marker, never a raw fallback.
Response captures also show bounded HTTP status, media-type classification and
body-shape classification. A missing capture in the earlier diagnostic is not
proof of an ARCA fiscal rejection: the old transport discarded DTD responses
before capturing them. Offline HTML/DOCTYPE fixtures reproduce that symptom, but
the original upstream response remains unknown; do not infer its exact cause.

### Isolate authentication first

To diagnose WSAA without running FEDummy, PV, numbering, catalog, reservation
consultations or any emission path:

```powershell
pnpm exec tsx scripts/homologacion-diagnostic.ts --client-id EXISTING_CLIENT_UUID --auth-only --debug-soap
```

This mode checks certificate validity/pair/CUIT, then acquires `wsfe` TA once.
It does not require the client's IVA condition to be `exento`, inspect migration
readiness, load reservations, create a PDF or consume a fiscal number. It cannot
be combined with preflight/emission/PDF arguments. An authentication error is
reported as stage **wsaa**, not wsfe. Do not repeat automatically on a fault.
Valid existing endpoint/certificate/service-scoped TA rows may be read; new TA
values remain only in the current process. Separate runs do not retain newly
acquired tickets. A repeated-ticket fault is a hypothesis until its actual code
is captured; a later successful run does not establish the prior fault's cause.

| Probe order | Operation | Dependency |
|---|---|---|
| 2a | `FEDummy`, without `Auth` | Fixed homologacion WSFE endpoint |
| 2b | `FEParamGetPtosVenta` | Valid pair/certificate dates, own CUIT and TA |
| 2c | `FECompUltimoAutorizado`, type 11 | Configured PV appears as active, unblocked CAE |
| 2d | `FEParamGetTiposCbte`, confirms active type 11 | TA; runs even if PV/ultimo fail |
| Existing heads | `FECompConsultar`, recorded tuple only | Trustworthy homologacion provenance |

The IVA-receptor catalog is **not** a substitute for 2d. This harness does not
request it; an independent future diagnostic would use `ClaseCmp="C"`, not `11`.

## Stop conditions

A PV error **602**, an empty list, or no active configured match means **STOP**.
There is no assumed PV1 exception. A client condition other than `exento`,
certificate/Auth CUIT mismatch, invalid pair/dates, unavailable type 11 or unresolved
old head also forbids issuance. The harness reports skipped dependencies honestly.
A consultation returning 602 means no record was returned, **not** proof that the
number is free. Preserve the old reservation, including terminal `EMIT_FAILED`
heads; do not delete, reuse, renumber or automatically repair it.

Preflight works before migration 0008 using explicit existing columns and reports
its absence. It does not apply migrations. New TA values stay only in memory;
existing certificate/endpoint/service-scoped cached entries may be read, unchanged.

## One explicitly authorized issuance (separate step)

Only after reviewing preflight evidence and receiving explicit authorization:

1. Review and separately approve migration `0008_emission_series_claims.sql` for
   the existing database. The harness never applies it. Unknown legacy environment
   stays `NULL` and fail-closed; no environment is guessed.
2. Select **one existing APPROVED invoice** whose recorded approval still matches
   the current exento issuer and reviewed recipient/amount. Prepare a local
   `operator-authorization.json` containing its complete `FECAEReq`: CUIT, PV,
   type **11**, expected number, recipient document/condition/name, emission/due
   dates, currency/rate, net/IVA/total integer-cent amounts and tax rate. The number
   must equal a fresh validated ARCA last+1. All fields are checked against the
   approved invoice; this file is authorization, not automatic data repair.
3. Run once, substituting actual existing UUIDs:

```powershell
pnpm exec tsx scripts/homologacion-diagnostic.ts --client-id EXISTING_CLIENT_UUID --invoice-id APPROVED_INVOICE_UUID --emit-once --expected-file operator-authorization.json --debug-soap --pdf
```

There is at most **one `FECAESolicitar` per run**, with no authentication retry,
resend or batch loop. A durable tuple marker and series claim are required before
sending; last+1 is rechecked under that claim. An expired/uncertain claim is **not**
permission to take over. On an unknown response, the same tuple is consulted once,
never resent. Explicit rejection stops. Any retry requires a new human decision;
there is no marker-deletion or automatic retry command.
Successful CAE/status persistence and release of that dispatch's exact owned
claim commit in one transaction. A later audit/log failure cannot strand its
series, and looking up an older CAE never clears a newer dispatch owner's claim.
The batch may still report `failed_transient` if its post-commit audit fails even
though a CAE and `EMITTED` status are persisted. Treat persisted fiscal evidence
as authoritative and use read-only lookup, never resend from that report alone.

Only a matching accepted CAE is persisted. `--pdf` then writes a **HOMOLOGACION**
watermarked PDF under `.data/homologacion/`. Null, rejected, malformed or unmatched
responses produce no PDF/QR artifact. QR `importe` is currency units: **625000
centavos -> 6250**, **625001 -> 6250.01**; the confirmed number and CAE are preserved.
Do not use the older `homologacion:spike` runner for this controlled workflow.

## Protocol and timing checks

- Public WSDL `FEDetRequest` sequence: `ImpOpEx`, **`ImpTrib`, `ImpIVA`**;
  `CondicionIVAReceptorId` follows `MonCotiz` (and optional `CanMisMonExt`) before
  `Iva`. Goods (`Concepto=1`) omit `FchVtoPago`. C has net=total, zero IVA, no `Iva`.
- TRA timestamps use the injected clock at now minus/plus ten minutes with explicit
  `-03:00` formatting. A new TA's actual expiration controls cache validity.
- Homologacion calls: **25s**; TA acquisition: **30s**; read-only services: **65s**;
  browser deadline: **70s**. Production timeout budgets remain unchanged. The manual
  sequential harness has a bounded **240s** transport budget.
- Fresh numbers use ARCA last+1, never `max(local, remote)+1`. Durable environment,
  CUIT, PV and type claims serialize allocation/reservation/send; a failed head
  blocks its series while independent series remain possible.

## Official references and evidence boundary

- [Live homologacion WSFE WSDL](https://wswhomo.afip.gov.ar/wsfev1/service.asmx?WSDL)
  (public fixture captured 2026-10-29 UTC in `src/adapters/arca/fixtures/`).
- [WSFE v4.0 developer manual](https://www.afip.gov.ar/fe/documentos/manual-desarrollador-ARCA-COMPG-v4-0.pdf).
- [WSAA developer manual](https://www.afip.gov.ar/ws/WSAA/WSAAmanualDev.pdf).
- [Official QR specification](https://www.arca.gob.ar/fe/qr/documentos/QRespecificaciones.pdf).

Offline tests validate envelopes, clocks, parsing, privacy, claims and gating. They
are **not** evidence of live ARCA availability, an enabled PV, issuance, a CAE or a
browser test. Record only the actual preflight result; blocked probes stay blocked.
