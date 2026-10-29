# Look up a CUIT without emitting invoices

The **Consulta de CUIT** page performs an authenticated, read-only Padrón lookup in homologation. It is not a fiscal eligibility check: **Homologación: datos de prueba; no acredita situación fiscal real**.

## Quick path

1. Save a usable certificate/key pair in **Credenciales ARCA**. Its public subject must identify a valid CUIT; WSAA authorization for `ws_sr_constancia_inscripcion` is required.
2. Open **Consulta de CUIT**, enter a CUIT (spaces/hyphens accepted), and submit. The checksum is validated locally and again on the server.
3. Read the test result: queried CUIT, environment, optional name, IVA condition, and query time. Missing data does not mean exemption, and a missing homologation record says nothing about production.

## Safety and interpretation

- Only `ARCA_ENV=homologacion` enables the endpoint. The server pins trusted test URLs; clients cannot choose the represented CUIT, service, environment, or endpoint.
- `getPersona_v2` sends the certificate's CUIT as `cuitRepresentada` and the submitted CUIT as `idPersona`. Authorization still depends on the provider's relationships; the application never claims the certificate alone grants access.
- Only explicit `AC` tax registrations are classified: 20 → monotributista, 30 → RI, 32 → exento. Conflicting, malformed, inactive, or unknown IVA evidence remains undetermined. Regime-block presence and CUIT prefixes are not classification evidence; 33/34 are not mapped to exento.
- Structured provider errors are failures, except the exact documented no-person result with matching target identity. The UI distinguishes no person, no supported condition, ambiguous data, and protocol errors.
- No clients, payers, registrations, invoices, or emission flags are changed. Only the existing certificate/WSAA-endpoint/service-scoped TA cache may be written. The legacy emission adapter is intentionally unchanged; its older block-presence classification is **not** used by this page.

## Bounds and limitations

Incoming JSON is limited to 1 KiB/2 seconds. Provider responses are limited to 1 MiB/25 seconds per call and the lookup to 65 seconds total. The browser has an independent 70-second deadline. Input/credential changes and unmount cancel the view and discard late results; credentials are rechecked before returning a server result.

An in-process, bounded attempt map deduplicates the same query and applies a 15-second credential-wide cooldown to different CUITs. Results cannot outlive their certificate or TA. This is not a distributed rate limiter: separate server processes have separate cooldowns. Shared TA acquisition remains single-flight within one process.

Offline tests cover protocol fixtures and safety controls, not acceptance by ARCA. No universal public test CUIT with guaranteed data is promised. Production registration, real-account eligibility, and full readiness to invoice cannot be inferred from any result here.

## Safe SOAP Fault diagnostics

A SOAP Fault remains a failed query, including when returned with HTTP 200. The page shows only the stage, category, HTTP status, correlation reference, and a fixed subtype: `validation-rejected` for the WSDL-defined `SRValidationException` detail; `unclassified` otherwise. Neither subtype identifies a specific authentication, authorization, or target-data cause. Provider fault messages, credentials, and personal data are never echoed or logged. The WSDL declares no numeric code in this fault detail.

If a fault persists, share only those displayed diagnostics and the reference. Do not share SOAP bodies, headers, tokens, certificates, private keys, or browser network exports.

## Public protocol references

The [ARCA Padrón manual, v4.1](https://www.afip.gob.ar/ws/WSCI/manual_ws_sr_ws_constancia_inscripcion.pdf), §2.5 and §3.2, and the [public homologation WSDL](https://awshomo.arca.gob.ar/sr-padron/webservices/personaServiceA5?WSDL) specify the current `awshomo.arca.gob.ar` endpoint, `getPersona_v2`, namespace `http://a5.soap.ws.server.puc.sr/`, ordered unqualified parameters (`token`, `sign`, `cuitRepresentada`, `idPersona`), and empty SOAPAction. The [production WSDL](https://aws.arca.gob.ar/sr-padron/webservices/personaServiceA5?WSDL) confirms its separate `aws.arca.gob.ar` address; this page still cannot select production. Tax IDs 20/30/32 are identified in the [official WSFE manual](https://www.afip.gov.ar/fe/ayuda/documentos/wsfev1-RG-4291.pdf). Only public documentation/WSDL GETs were used to verify this contract; no authenticated provider call was made. Updating the previous AFIP-host constants aligns with current documentation but does not establish the cause of a previously observed SOAP Fault.
