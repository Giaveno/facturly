# Receipt review workbench

## Explicit workflow

1. OCR must complete before fields can be edited. PENDING and FAILED OCR rows cannot be corrected or confirmed.
2. `POST /api/rows/:rowId/corrections` accepts `{ name, cuit, date, amount }`. `amount` is a positive safe integer in centavos; `date` is the receipt date, not the fiscal emission date.
3. Saving validates all four fields, preserves original OCR confidence, records changed-field manual provenance and before/after values in the audit log, and teaches the payer registry. It sets CORRECTED/PENDING, invalidating any old review confirmation.
4. `POST /api/invoices/:invoiceId/review` explicitly confirms complete, valid CONFIDENT/CORRECTED data and synchronizes the invoice amount. Reading the page never confirms review.
5. Approval is separate and requires the contextual dialog. The server still resolves fiscal type from the recipient IVA condition; it is not editable OCR data.
6. Approved, emitting, emitted, failed-emission and rejected invoices are read-only. Rejection remains available before approval and requires a reason.

## Approval HTTP contract

`POST /api/invoices/:invoiceId/approve` now requires JSON:

```json
{
  "expected": {
    "rowId": "OCR row UUID",
    "name": "Displayed recipient name",
    "cuit": "Displayed valid recipient CUIT",
    "date": "YYYY-MM-DD",
    "amount": 100,
    "issuerCuit": "Displayed issuer CUIT",
    "issuerName": "Displayed issuer name",
    "ptoVta": 1,
    "environment": "homologacion"
  }
}
```

The snapshot is compared to current inputs inside the same OCR-row lock used by correction, confirmation, rejection and approval. Missing/invalid snapshots return 400; stale snapshots return 409 before gateway lookup and never enqueue emission. The environment label uses the same resolver as the actual gateway endpoint composition. Trusted internal service calls can omit the HTTP snapshot.

Approval holds the review transaction lock through the IVA lookup. This intentionally favors consistency over parallel editing latency. Unresolved-IVA audit entries are written after rollback so failed approval attempts remain visible.

## Image and drafts

`GET /api/rows/:rowId/image` requires the accountant session and resolves the private photo internally. It never accepts an object key or path. It validates stored keys, sniffs supported image bytes, and returns private/no-store, nosniff and same-origin resource policy headers. Missing, legacy or unavailable stored images have an honest unavailable state. The local storage adapter remains unsuitable for production/multi-instance deployment.

Drafts survive row/filter changes and client-route Back/Forward remounts in transient tab memory. Only IDs present in the authenticated read model are restored. Receipt data is not written to history.state, localStorage or sessionStorage. Deliberate link navigation asks before discarding; beforeunload guards hard navigation.

## Verification scope

Offline PGlite tests cover validation, readiness gates, stale/zero snapshots, correction-versus-approval ordering, audits, learning and image boundaries. Node React static-markup tests cover rendered states; they are NOT browser interaction, focus or responsive screenshot verification. The scoped CSS follows the ZIP queue/viewer/details proportions and 1120/760px breakpoints. DM Sans/Space Grotesk font stacks use local fallbacks unless font assets are provided.
