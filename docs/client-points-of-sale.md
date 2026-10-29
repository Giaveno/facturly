# Homologation points of sale

The Clients action **Consultar puntos de venta en homologación** performs only
`FEParamGetPtosVenta` for the client's stored CUIT. It does not issue invoices,
create/update points of sale, change the configured client, register ARCA
delegations or enable emissions. `EMISSIONS_ENABLED` is not consulted or changed.

## Safety boundary

- Authenticated same-origin POST `/api/clients/[id]/points-of-sale`, valid UUID,
  and the public certificate fingerprint only. CUIT, endpoints, service and PV
  cannot be overridden by request payloads.
- Both route and service require exactly `ARCA_ENV=homologacion` before database
  credential access or network calls. Only trusted homologation WSAA/WSFE URLs
  are used; redirects are rejected.
- Encrypted persisted credentials are decrypted just in time. The existing
  durable, certificate-and-WSAA-endpoint-scoped `wsfe` TA cache avoids unnecessary
  LoginCms calls. Concurrent cache reads/refreshes also share a process-local
  certificate/endpoint/service identity across different clients and diagnostics;
  completed tickets remain only in the durable cache. Pending identities are
  bounded to 128 and independently expire after eight seconds even if persistence
  hangs; late reads cannot start a new remote call. Cache writes are the only
  persistence side effect.
- Four-second outbound deadlines cover fetch and streamed body reads, with a
  1 MiB body cap; the complete service operation has a ten-second deadline.
  Browser requests have a twelve-second deadline. Exceptions/upstream text and
  credentials are never logged or returned.
- Same-process requests share an identity/client-snapshot-scoped attempt for
  fifteen seconds, including failures; memory is bounded to 128 attempts.
  This is not a distributed rate limiter. Results are not persisted and all
  responses use `Cache-Control: no-store`.
- Client existence/values and credential contents are rechecked before returning.
  Ticket expiry is checked before/after WSFE. UI edits, refreshed props and
  certificate changes discard the previous mounted verification and in-flight
  responses. Results are point-in-time, not continuous monitoring of other tabs.

## Reading the result

The list preserves all five digits. Client configuration now accepts 1..99998,
matching WSFE validation 11000; there is no schema migration.

Only a returned point with `EmisionTipo=CAE`, `Bloqueado=N`, no deregistration
date and recognized fields counts as available for the configured CAE point.
CAEA-only, blocked, deregistered and missing points are not a CAE match. Unknown
flags/types or malformed dates remain unverified. An undocumented date sentinel
such as `00000000` is conservatively unknown, not silently interpreted as active.
No result implies full fiscal readiness, authorization to issue, IVA correctness,
or successful issuance. Selecting a different point still requires an explicit
client edit and a new query.

## Protocol evidence and verification limits

Consulted the official ARCA indexed documentation:

- [Current WSFE developer manual](https://www.arca.gob.ar/ws/documentacion/manuales/manual-desarrollador-ARCA-COMPG.pdf):
  `FEParamGetPtosVenta`, five-digit Nro, CAE/CAEA type, S/N blocking flag and
  optional eight-digit deregistration date.
- [WSFE v4.1 manual](https://www.arca.gob.ar/ws/documentacion/manuales/manual-desarrollador-ARCA-COMPG-v4-1.pdf):
  validation 11000 restricts configured points to 1..99998.

Full PDF retrieval returned timeout/404 during implementation; official indexed
excerpts were available. Protocol, service, HTTP route and browser orchestration
are tested offline with synthetic SOAP, generated test certificates and mocked
fetch/persistence. No live database, WSAA/WSFE request, invoice issuance or browser
verification was performed. Live acceptance remains unverified.
