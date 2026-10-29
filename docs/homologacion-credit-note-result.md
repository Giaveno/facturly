# One-shot homologation credit note result

Executed on 2026-10-29 through `emitComprobante`, without retry, with sandbox CUIT
33693450239 and point of sale 1. No production issuance.

- Original: approved Factura B (006), 00001-00000109, total ARS 1210.
- Credit note: approved Nota de Crédito B (008), 00001-00000003.
- CAE: 86441033099752; expires 2026-11-08.
- FECompConsultar confirmed CAE, number and fiscal amounts.
- WSFE calls: 2 FECompUltimoAutorizado, 1 FECAESolicitar, 1 FECompConsultar.
- WSAA calls: 0 (persistent ticket cache hit).
- Local complete sanitized log: `.data/prueba-nc.log`.
- Local PDFs: `.data/factura-b-109.pdf`, `.data/nota-credito-b-3.pdf`.

The execution marker `.data/prueba-nc.started.json` prevents rerunning the operator
script. Do not delete the marker or issue another credit note for this test.
