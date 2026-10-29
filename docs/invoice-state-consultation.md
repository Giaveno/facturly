# Check an existing reserved invoice without emitting

The **Facturas** page now has a separate **Intentos con número reservado — sin CAE local** panel. It queries the existing reservation in ARCA homologation, without retrying issuance or changing any fiscal state. The original live provider outcome remains unknown until a trustworthy consultation result is obtained.

## Quick path

1. Restart the app normally to load the updated code. Keep the emission switch disabled; this consultation works with `EMISSIONS_ENABLED=false`. Do not create or approve another invoice for the same sale.
2. Open **Facturas** and find the existing attempt using its invoice reference and reserved type / point of sale / number. The failed attempt discussed in this investigation is `14c489be-4386-46ec-a230-3a3baf1a1eac`.
3. Select **Consultar estado en ARCA (homologación)** on that row. Wait for the row's result, then share it before deciding any recovery. No SQL or browser console is needed.

The action requires the current environment to be explicitly `homologacion` **and** a valid persisted approval snapshot identifying homologation and the same issuer / point of sale / amount. Legacy or missing environment evidence blocks the lookup before secrets or network access. Changing the current environment alone does not make a production or unknown reservation safe.

## Interpret the result

| Result | Meaning |
|---|---|
| Matching CAE authorization | ARCA returned an accepted **CAE** record matching the reserved number, type, point of sale, amounts, currency, exchange rate, recipient document and emission date. The locally failed/pending invoice is unchanged. |
| Unverified | ARCA returned a record, but a required fiscal field is missing, mismatched, rejected or not CAE mode. A syntactically valid returned CAE is evidence only, not a local authorization. |
| No records returned / code 602 | ARCA returned no record for this query. This is **not proof that the invoice was never issued**. |
| Provider/query failure | The fiscal outcome remains unknown. A timeout, malformed SOAP reply, network error or provider error is never displayed as “not issued”. Only safe stage/category/numeric codes are shown. |

The issued-invoice list and its PDF links remain separate and unchanged. A consultation cannot add an invoice there, store a CAE, unlock a PDF, reset a reservation, or change `EMIT_FAILED` to another status. There is no resubmit action in the attempt panel.

## Safety boundaries

- The request accepts only an invoice ID; the server reads the exact persisted issuer CUIT, point of sale, type and number. Mutable client settings cannot replace the reservation.
- Only `FECompConsultar` is used, against fixed homologation endpoints. It never calls issuance, last-number allocation, batch emission, approval or the recovery sweeper. In particular, **do not use `recoverStuckEmissions` for this investigation**: that path attempts issuance first.
- The only possible persistence is the existing certificate/endpoint/service-scoped WSAA ticket cache. Invoice, reservation and audit rows are not changed by this action.
- The server rechecks the reservation and certificate after asynchronous work, including before WSFE after WSAA. Results for changed identities are discarded. Client requests have stale-result/double-click guards and a 15-second cooldown; server attempts share a bounded short-lived in-flight/result cache.
- HTTP calls have a four-second deadline, an overall ten-second deadline, a 1 MiB response cap and no redirects. SOAP parsing rejects malformed XML, DTD/entities, missing result/detail/header and ambiguous repeated shapes. Provider text, tokens, signatures, keys and PEMs are not exposed or logged.

## Protocol fix and limits

Issuance and consultation now use the full quoted SOAP 1.1 actions published by [ARCA: FECAESolicitar](https://wswhomo.afip.gov.ar/wsfev1/service.asmx?op=FECAESolicitar) and [ARCA: FECompConsultar](https://wswhomo.afip.gov.ar/wsfev1/service.asmx?op=FECompConsultar). A missing issuance result/header is no longer manufactured into `Resultado=R`. Malformed issuance remains terminal through the existing guard and is labeled **outcome uncertain**, rather than becoming automatically retryable.

An explicit Errors-only response preserves its numeric taxonomy instead of fabricating a header. Code 600 keeps the existing authentication handling. Code 10015 is recipient-document validation and is not treated as duplicate evidence; code 10016 is a possible numbering/date conflict, not proof of prior authorization. Only complete matching consultation evidence can supply a prior CAE. Malformed or incomplete consultation during that existing gateway path is terminal/uncertain, not an automatically retryable unknown error. See the official [WSFE developer manual, validation tables on pages 38–39](https://www.afip.gob.ar/ws/WSFEV1/documentos/manual_desarrollador_COMPG_v3_3.pdf).

FECompConsultar does not return issuer CUIT in its record. Issuer evidence is the requested persisted CUIT plus the trusted homologation endpoint; the app does not invent a returned issuer field. Missing required comparison fields cannot produce a matching result.

Verification is offline only: synthetic XML, injected transports and isolated in-memory PGlite databases. No browser session, live provider response, real CAE or repaired provider rejection is claimed. No user database migration is required. Restarting the app does not itself resolve the failed attempt.

## Next step

Share the selected row's consultation outcome. Any data correction, status reconciliation, retry, reset or new issuance needs a separate explicit decision; none is part of this read-only check.
