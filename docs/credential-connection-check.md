# Credential authentication check

Saving `/credentials` validates and encrypts the certificate/private-key pair first.
The success message confirms storage only. The form immediately clears pasted
PEMs, then automatically POSTs only the saved certificate's public SHA-256
fingerprint to `/api/credentials/check`. **Probar conexión en homologación** retries
that diagnostic without uploading the private key again.

The diagnostic requires an authenticated accountant and an allowed `Origin`.
`ARCA_ENV` must equal `homologacion` explicitly; production, missing and invalid
values are refused before accessing the database or network. No request-selected
URL, service, certificate or private key is accepted. The server decrypts the
persisted private key just in time and authenticates `wsfe` and
`ws_sr_constancia_inscripcion` through the fixed homologation WSAA endpoint.
Redirects are rejected. Each remote call has a 25-second timeout; the whole check
has a 65-second budget (including persistence). Responses are `no-store` and
contain only public certificate metadata and `ok`, `failure`, `timeout` or
`not_configured` service statuses, never tickets, keys, remote payloads or stacks.

This does **not** call `FECAESolicitar`, issue an invoice, alter the emission
switch, configure a point of sale, validate an issuer, or prove fiscal readiness.
Network/authentication failures do not undo saved credentials. A mismatched or
replaced certificate invalidates the result; the client also ignores obsolete
requests. A server-side certificate re-read protects against replacement during
the check.

## Cache and operational limits

The gateway and diagnostic share durable TA keys containing the WSAA endpoint,
canonical certificate SHA-256 and service. Provider-based credentials are resolved
before selecting the cache, so rotation cannot reuse another certificate's TA.
Expired/empty tickets cannot produce an OK diagnostic. Successful diagnostic
memoization never extends a ticket's actual expiry.

Concurrent diagnostic requests share an attempt within a process, with a
15-second cooldown. This is **not a distributed rate limiter**: simultaneous cold
starts can still contend. Durable TA reuse limits repeat LoginCms requests after
restart. Legacy service-only/old fingerprint keys are intentionally not trusted,
because their certificate/environment provenance is unknown; a still-active
legacy/external ticket may cause an authentication failure until it expires.
The diagnostic does not bypass this by treating `alreadyAuthenticated` as OK.

WSAA prerequisites corrected alongside this feature: the testing authentication
host is `wsaahomo.afip.gov.ar` (not the WSFE `wswhomo` host), LoginCms returns an
XML ticket string, and TRA `uniqueId` is an unsigned 32-bit integer. Sources:
[official WSAA documentation](https://www.afip.gob.ar/ws/documentacion/wsaa.asp)
and [WSAA technical specification 1.2.0](https://www.afip.gob.ar/ws/WSAA/Especificacion_Tecnica_WSAA_1.2.0.pdf).

## Verification boundary

Tests use generated self-signed certificates, mocked HTTP, an offline PGlite
database where applicable, client-workflow tests and server-rendered markup.
No real credentials, live database, ARCA service, invoice issuance, browser
session, environment-file read, install, build or application startup is required.
These checks do not prove that ARCA will accept a real certificate/signature or
that an external account has granted either business-service authorization.
Do not use `homologacion:spike` as a connection check: it emits an invoice.
