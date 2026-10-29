# Review anonymous consumers or invoice a CUIT

New uploads intentionally default to **Consumidor Final**. OCR evidence is not a fiscal identity decision. Every upload still requires an accountant to confirm review, then separately approve emission. Saving never confirms or approves.

## Quick path

1. Upload to the correct issuer and review the original receipt, date and total. Anonymous consumer-final invoices do not require a name or buyer CUIT.
2. For an identified recipient, edit **Modo de destinatario → Facturar a un CUIT**, enter the CUIT and verify the recipient name. Changing modes clears the inapplicable CUIT input; saving revokes prior confirmation.
3. For RI issuers, explicitly select the taxable sale rate (10.5%, 21% or 27%). There is no default rate. This slice supports products with one taxable rate only, not services, exemptions, mixed rates or other taxes.
4. Save, confirm review, then inspect the approval dialog and environment. Approving may queue real issuance; saving and confirming do not. Padrón classification happens at approval, not during OCR or as a hidden UI guess.

## Fiscal boundaries

| Topic | Behavior |
|---|---|
| Anonymous consumer | Document 99 / number 0 / recipient IVA condition 5; fiscal name is Consumidor Final. No Padrón query, payer-registry lookup, inferred CUIT or registry learning. Direct OCR name/CUIT evidence and confidence are not reclassified as manual fiscal data. |
| Identified CUIT | Normalize spaces/hyphens and validate checksum; query authenticated Padrón for the current CUIT at each approval. Only explicit active taxes 20/30/32 establish mono/RI/exento. Conflicts, unsupported taxes, missing evidence and errors block approval. CUIT prefixes and mere regime-block presence are not evidence. |
| Document type | RI → RI or mono: A (mono includes the existing Ley 27.618 legend). RI → CF or exento: B. Mono/exento issuer: C. CUIT identification alone does not select a tax condition or invoice letter. |
| Amounts | Taxable A/B split gross total into integer-cent net and IVA using the selected rate; WSFE rates map to IDs 4/5/6. C has net=total and IVA=0 and omits the Iva XML element entirely. |
| Identification limit | Anonymous mode only below ARS 10,000,000 (1,000,000,000 cents). The exact boundary and above fail closed, with guidance to identify the recipient. This restricted flow supports CUIT with verifiable IVA only; DNI/CUIL/CDI/passport and identified CF without supported tax evidence require another enabled system. Do not change the recipient's tax condition to bypass this restriction. Requests requiring CUIT for income-tax deductions must not use anonymous mode even below the limit. |
| Concurrency | Every edit takes the existing row lock and returns the invoice to PENDING. Approval compares the displayed mode, normalized identifier, rate, total/date/name, issuer identity/condition/PV and environment. Persisted approval context is checked again before dispatch, rejecting subsequent issuer/row/environment drift. |
| Outputs | Export shows CF with no CUIT and document99/0. PDF/QR retain99/0. New homologation approval snapshots drive a clear non-fiscal PDF banner; unknown legacy environments are not inferred from current configuration. |

The identification policy is versioned as `arca-rg5866-2026-10-28` in `src/domain/receipt.ts`, deliberately requiring a reviewed code/policy update when the legal boundary changes. Verified against [ARCA compulsory invoice data](https://arca.gob.ar/fe/emision-autorizacion/datos-comprobantes.asp) and the [current RG1415 text](https://biblioteca.arca.gob.ar/search/query/norma.aspx?p=t%3ARAG%7Cn%3A1415%7Co%3A3%7Ca%3A2003%7Cf%3A07%2F01%2F2003). [ARCA WSFE developer documentation](https://www.arca.gob.ar/fe/ayuda/documentos/Manual-desarrollador-V.2.21.pdf) documents C's prohibited Iva array (10071) and the IVA catalog; its historical identification thresholds are not used.

## Migration and safe rollout

- Migration `0007_recipient_modes.sql` follows the existing, unapplied `0006_receipt_cleanup.sql`. No user database migration was run during implementation. Back up and review the complete migration chain before a human applies it in the intended environment.
- Existing rows with any CUIT evidence or a fiscal document80 remain identified, even if the CUIT later needs correction. Other legacy rows default CF with `legacy_migration` provenance. All legacy REVIEWED invoices return to PENDING for explicit confirmation. APPROVED/in-flight/terminal fiscal states and reservations are not silently reset or reapproved.
- Legacy taxable A/B approvals or retries without an explicit rate/correct amounts fail before allocation; they need controlled manual fiscal remediation. The previous implicit A rate is not guessed during recovery. New snapshots prevent context drift; legacy approvals without snapshots cannot gain historical issuer/environment provenance retroactively.
- Existing reservations have no environment namespace. **Never switch homologation and production against the same database or mix demo/test reservations with user records.** Use dedicated databases. Snapshot environment checks are defense in depth, not a reservation-namespace migration.
- Credentials, actual test issuer/PV, delegation and Padrón availability remain externally unverified. A checksum-valid student's CUIT is not proof of an authorized issuer or a usable homologation Padrón record. ARCA can reject it.
- Keep kill switches, authentication, same-origin checks and explicit approval intact. This work does not enable emissions or make production-readiness/compliance claims. The existing minimal PDF is not a complete legal invoice layout; full fiscal-transparency presentation and issuer/address details require separate review.

## Manual homologation acceptance (human-controlled)

- [ ] In a dedicated homologation database, apply reviewed migrations; verify `ARCA_ENV=homologacion`, configured issuer/PV, certificate and service relationships. Do not use production credentials or the real user database for fixture experiments.
- [ ] Upload a real receipt: it must remain pending manual review even if OCR is confident. Confirming without editing must preserve OCR confidence and leave emission unapproved.
- [ ] Anonymous CF: no buyer CUIT requirement below the limit; no Padrón call. Check RI rate selection/B breakdown or mono/exento C as applicable.
- [ ] Identified: manually enter CUIT, save and confirm; successful supported Padrón evidence selects the correct letter. Unknown/failure stays blocked without converting to CF.
- [ ] Change CUIT, recipient mode or rate in another tab: old confirmation/approval snapshots must not authorize the new values. Confirm again deliberately.
- [ ] Test exact limit minus one cent, the exact limit and plus one cent without approving unsupported identification.
- [ ] Only after inspecting environment and accepting the fiscal action, explicitly approve an authorized homologation case. Verify provider result, PDF non-fiscal banner, QR99/0 for CF and export without a fictitious CUIT. A queued approval is not a CAE; no PDF is available before issuance.

Offline tests cover the application boundaries with in-memory Postgres and fake/injected gateways. They do not prove browser interaction, live ARCA acceptance, issuer eligibility, or production readiness.
