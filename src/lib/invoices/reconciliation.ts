import { HOMOLOGACION_CALL_MS, HOMOLOGACION_QUERY_MS } from "@/adapters/arca/timeouts";
import { createHash } from "node:crypto";
import { eq, isNull } from "drizzle-orm";
import { ARCA_SERVICE_WSFE, WSAA_HOMOLOGACION_URL, WSFE_HOMOLOGACION_URL } from "@/adapters/arca/constants";
import { createCredentialTaCache } from "@/adapters/arca/credential-ta-cache";
import { ArcaQueryError, safeQueryDiagnostic, type QueryDiagnostic, type QueryStage } from "@/adapters/arca/query-diagnostics";
import { parseSoapFault } from "@/adapters/arca/errors";
import { WsfeClient, parseFecompConsultarResponse, type FecompConsultarResult } from "@/adapters/arca/wsfe";
import type { TaCacheStore } from "@/adapters/arca/ta-cache";
import { inspectCertificate, assertKeyMatchesCertificate } from "@/lib/credentials/pem";
import { decryptPrivateKey, deriveAesKey } from "@/lib/db/credentials";
import { DrizzleCredentialsRepository, type CredentialsRepository } from "@/lib/db/credentials-repository";
import { DrizzleTaCacheStore } from "@/lib/db/ta-cache-store";
import { auditLog, invoices, issuedInvoices } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { isValidCuit } from "@/domain/cuit";
import { parseApprovalSnapshot } from "@/domain/approval-snapshot";
import { deriveAmounts } from "@/domain/amounts";
import type { CbteTipo } from "@/domain/policy";
export interface ReservedInvoice {
    invoiceId: string;
    reservationId: string;
    status: string;
    cae: string | null;
    cuit: string;
    ptoVta: number;
    cbteTipo: number;
    cbteNro: number;
    importeTotalCentavos: number;
    invoiceCbteTipo: number | null;
    net: number | null;
    iva: number | null;
    total: number | null;
    moneda: string | null;
    cotizacion: number | null;
    docTipo: number | null;
    docNro: number | null;
    fechaEmision: string | null;
    approvalSnapshot: unknown;
    condicionIvaReceptorId?: number | null;
}
export interface ConsultationReport {
    environment: "homologacion";
    invoiceId: string;
    checkedAt: string;
    tuple: {
        cuit: string;
        ptoVta: number;
        cbteTipo: number;
        cbteNro: number;
    };
    status: "matched" | "unverified" | "no-record";
    cae: string | null;
    caeFchVto: string | null;
    diagnostic?: QueryDiagnostic;
}
export class InvoiceConsultationError extends Error {
    readonly diagnostic?: QueryDiagnostic;
    constructor(readonly code: "environment" | "not_found" | "credentials" | "changed" | "upstream" | "cooldown", diagnostic?: QueryDiagnostic) { super(code); this.diagnostic = safeQueryDiagnostic(diagnostic); }
}
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
function trusted(r: Pick<ReservedInvoice, "approvalSnapshot" | "cuit" | "ptoVta" | "importeTotalCentavos">): boolean {
    try {
        const s = parseApprovalSnapshot(r.approvalSnapshot);
        return s.environment === "homologacion" && s.issuerCuit === r.cuit && s.ptoVta === r.ptoVta && s.amount === r.importeTotalCentavos;
    }
    catch {
        return false;
    }
}
export function compareFiscalEvidence(r: ReservedInvoice, e: FecompConsultarResult): "matched" | "unverified" {
    if (!trusted(r))
        return "unverified";
    try {
        const approval = parseApprovalSnapshot(r.approvalSnapshot);
        const amounts = deriveAmounts(approval.amount, r.cbteTipo as CbteTipo, approval.taxRate);
        if (amounts.net !== r.net || amounts.iva !== r.iva || amounts.total !== r.total ||
            (approval.recipientMode === "consumer_final" ? r.docTipo !== 99 || r.docNro !== 0 : r.docTipo !== 80 || r.docNro !== Number(approval.cuit)))
            return "unverified";
    }
    catch {
        return "unverified";
    }
    if ((e.condicionIvaReceptorId != null && e.condicionIvaReceptorId !== r.condicionIvaReceptorId) ||
        (e.concepto != null && e.concepto !== 1) ||
        [e.impTotConcCentavos, e.impOpExCentavos, e.impTribCentavos].some(value => value != null && value !== 0))
        return "unverified";
    const pairs = [[e.cbteNro, r.cbteNro], [e.ptoVta, r.ptoVta], [e.cbteTipo, r.cbteTipo], [r.invoiceCbteTipo, r.cbteTipo],
        [e.impTotalCentavos, r.importeTotalCentavos], [e.impTotalCentavos, r.total], [e.impNetoCentavos, r.net], [e.impIvaCentavos, r.iva],
        [e.moneda, r.moneda], [e.cotizacion, r.cotizacion], [e.docTipo, r.docTipo], [e.docNro, r.docNro], [e.fechaEmision, r.fechaEmision?.replaceAll("-", "")]];
    return e.resultado === "A" && e.emissionType === "CAE" && !!e.cae && !!e.caeFchVto && pairs.every(([a, b]) => a !== null && a !== undefined && b !== null && b !== undefined && a === b) ? "matched" : "unverified";
}
interface Attempt {
    at: number;
    validUntil: number;
    promise: Promise<ConsultationReport>;
}
interface Options {
    env: Record<string, string | undefined>;
    repository: CredentialsRepository;
    getReservation: (id: string) => Promise<ReservedInvoice | null>;
    store: TaCacheStore;
    fetchFn?: typeof fetch;
    attempts?: Map<string, Attempt>;
}
async function bounded<T>(ms: number, run: (signal: AbortSignal) => Promise<T>, stage: () => QueryStage | undefined, parent?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let abort!: () => void;
    const timeout = new Promise<never>((_, reject) => {
        abort = () => {
            controller.abort();
            const current = stage();
            reject(new InvoiceConsultationError("upstream", current ? { stage: current, category: "timeout" } : undefined));
        };
        timer = setTimeout(abort, ms);
    });
    parent?.addEventListener("abort", abort, { once: true });
    if (parent?.aborted) abort();
    try {
        return await Promise.race([run(controller.signal), timeout]);
    }
    finally {
        clearTimeout(timer!);
        parent?.removeEventListener("abort", abort);
        controller.abort();
    }
}
/** FECompConsultar only. No emission port, number allocator, or fiscal writer exists here. */
export function createInvoiceConsultation({ env, repository, getReservation, store, fetchFn = fetch, attempts = new Map() }: Options) {
    return async (invoiceId: string): Promise<ConsultationReport> => {
        if (env.ARCA_ENV !== "homologacion")
            throw new InvoiceConsultationError("environment");
        let stage: QueryStage | undefined;
        return bounded(HOMOLOGACION_QUERY_MS, async (signal) => {
            const row = await getReservation(invoiceId);
            signal.throwIfAborted();
            if (!row || row.cae !== null)
                throw new InvoiceConsultationError("not_found");
            if (!trusted(row))
                throw new InvoiceConsultationError("environment");
            if (!isValidCuit(row.cuit) || ![1, 6, 11].includes(row.cbteTipo) || !Number.isInteger(row.ptoVta) || row.ptoVta < 1 || row.ptoVta > 99999 || !Number.isSafeInteger(row.cbteNro) || row.cbteNro < 1 || row.cbteNro > 99999999)
                throw new InvoiceConsultationError("upstream");
            const stored = await repository.get();
            signal.throwIfAborted();
            if (!stored)
                throw new InvoiceConsultationError("credentials");
            let cert: ReturnType<typeof inspectCertificate>;
            let keyPem: string;
            try {
                cert = inspectCertificate(stored.certPem);
                if (Date.parse(cert.notBefore) > Date.now() || Date.parse(cert.notAfter) <= Date.now())
                    throw new Error();
                keyPem = decryptPrivateKey(stored.encryptedKey, deriveAesKey(env.AES_KEY ?? ""));
                assertKeyMatchesCertificate(stored.certPem, keyPem);
            }
            catch {
                throw new InvoiceConsultationError("credentials");
            }
            const snapshot = hash(row), identity = hash(stored), key = hash([snapshot, identity]);
            for (const [k, a] of attempts)
                if (Date.now() - a.at >= 15000 || Date.now() >= a.validUntil)
                    attempts.delete(k);
            let attempt = attempts.get(key);
            if (!attempt) {
                if (attempts.size >= 128)
                    throw new InvoiceConsultationError("cooldown");
                attempt = { at: Date.now(), validUntil: Date.parse(cert.notAfter), promise: undefined! };
                const current = attempt;
                current.promise = (async () => {
                    const transport = { post: async (url: string, body: string, headers: Record<string, string>) => {
                            const callStage: QueryStage = url === WSAA_HOMOLOGACION_URL ? "wsaa" : "wsfe";
                            return bounded(HOMOLOGACION_CALL_MS, async (callSignal) => {
                                if (url !== WSAA_HOMOLOGACION_URL && url !== WSFE_HOMOLOGACION_URL)
                                    throw new ArcaQueryError(callStage, "internal");
                                // The outer signal is checked before and after each awaited operation.
                                signal.throwIfAborted();
                                try {
                                    const response = await fetchFn(url, { method: "POST", body, headers, redirect: "error", cache: "no-store", signal: callSignal });
                                    if (Number(response.headers.get("content-length")) > 1048576)
                                        throw new ArcaQueryError(callStage, "response-too-large");
                                    if (!response.body)
                                        throw new ArcaQueryError(callStage, "malformed-response");
                                    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
                                    let bytes = 0;
                                    const cancel = () => { void reader.cancel().catch(() => { }); };
                                    callSignal.addEventListener("abort", cancel, { once: true });
                                    let xml: string;
                                    try {
                                        for (;;) {
                                            signal.throwIfAborted();
                                            callSignal.throwIfAborted();
                                            const { done, value } = await reader.read();
                                            callSignal.throwIfAborted();
                                            if (done)
                                                break;
                                            bytes += value.byteLength;
                                            if (bytes > 1048576)
                                                throw new ArcaQueryError(callStage, "response-too-large");
                                            chunks.push(value);
                                        }
                                        xml = Buffer.concat(chunks).toString("utf8");
                                    }
                                    finally {
                                        callSignal.removeEventListener("abort", cancel);
                                        cancel();
                                    }
                                    if (parseSoapFault(xml))
                                        throw new ArcaQueryError(callStage, "soap-fault", { httpStatus: response.status });
                                    if (!response.ok && callStage === "wsfe") {
                                        try { parseFecompConsultarResponse(xml); }
                                        catch (error) {
                                            if (error instanceof ArcaQueryError && error.diagnostic.category === "provider-errors")
                                                throw new ArcaQueryError(callStage, "provider-errors", { httpStatus: response.status, providerCodes: error.diagnostic.providerCodes });
                                        }
                                    }
                                    if (!response.ok)
                                        throw new ArcaQueryError(callStage, "http", { httpStatus: response.status });
                                    return xml;
                                }
                                catch (error) {
                                    if (error instanceof ArcaQueryError)
                                        throw error;
                                    throw new ArcaQueryError(callStage, callSignal.aborted ? "timeout" : "network");
                                }
                            }, () => callStage, signal);
                        } };
                    try {
                        stage = "wsaa";
                        const ticket = await createCredentialTaCache({ url: WSAA_HOMOLOGACION_URL, credentials: { certPem: stored.certPem, keyPem }, store, transport }).get(ARCA_SERVICE_WSFE);
                        signal.throwIfAborted();
                        current.validUntil = Math.min(current.validUntil, Date.parse(ticket.expirationTime));
                        if (!ticket.token.trim() || !ticket.sign.trim() || !Number.isFinite(current.validUntil) || current.validUntil <= Date.now())
                            throw new ArcaQueryError("wsaa", "malformed-response");
                        // Revalidate before WSFE as well as after it: certificate/tuple changes during WSAA fail closed.
                        if (hash(await getReservation(invoiceId)) !== snapshot || hash(await repository.get()) !== identity)
                            throw new InvoiceConsultationError("changed");
                        signal.throwIfAborted();
                        stage = "wsfe";
                        const evidence = await new WsfeClient({ url: WSFE_HOMOLOGACION_URL, transport }).consultarComprobante({ token: ticket.token, sign: ticket.sign, cuit: row.cuit }, { ptoVta: row.ptoVta, cbteTipo: row.cbteTipo, cbteNro: row.cbteNro });
                        return report(compareFiscalEvidence(row, evidence), evidence.cae, evidence.caeFchVto);
                    }
                    catch (error) {
                        if (error instanceof InvoiceConsultationError)
                            throw error;
                        if (error instanceof ArcaQueryError && error.diagnostic.category === "provider-errors" && error.diagnostic.httpStatus === undefined && error.diagnostic.providerCodes?.length === 1 && error.diagnostic.providerCodes[0] === 602)
                            return { ...report("no-record", null, null), diagnostic: error.diagnostic };
                        throw new InvoiceConsultationError("upstream", error instanceof ArcaQueryError ? error.diagnostic : stage ? { stage, category: "internal" } : undefined);
                    }
                })();
                attempts.set(key, current);
            }
            function report(status: ConsultationReport["status"], cae: string | null, caeFchVto: string | null): ConsultationReport { return { environment: "homologacion", invoiceId, checkedAt: new Date().toISOString(), tuple: { cuit: row!.cuit, ptoVta: row!.ptoVta, cbteTipo: row!.cbteTipo, cbteNro: row!.cbteNro }, status, cae, caeFchVto }; }
            const result = await attempt.promise;
            signal.throwIfAborted();
            if (hash(await getReservation(invoiceId)) !== snapshot || hash(await repository.get()) !== identity)
                throw new InvoiceConsultationError("changed");
            signal.throwIfAborted();
            if (Date.now() >= attempt.validUntil)
                throw new InvoiceConsultationError("changed");
            return result;
        }, () => stage);
    };
}
export async function loadReservedInvoice(db: Db, id: string): Promise<ReservedInvoice | null> {
    const [r] = await db.select({ invoiceId: invoices.id, reservationId: issuedInvoices.id, status: invoices.status, cae: issuedInvoices.cae, cuit: issuedInvoices.cuit, ptoVta: issuedInvoices.ptoVta, cbteTipo: issuedInvoices.cbteTipo, cbteNro: issuedInvoices.cbteNro, importeTotalCentavos: issuedInvoices.importeTotalCentavos, invoiceCbteTipo: invoices.cbteTipo, net: invoices.importeNetoCentavos, iva: invoices.importeIvaCentavos, total: invoices.importeTotalCentavos, moneda: invoices.moneda, cotizacion: invoices.cotizacion, condicionIvaReceptorId: invoices.condicionIvaReceptorId, docTipo: invoices.receptorDocTipo, docNro: invoices.receptorDocNro, fechaEmision: invoices.fechaEmision, approvalSnapshot: invoices.approvalSnapshot }).from(issuedInvoices).innerJoin(invoices, eq(issuedInvoices.invoiceId, invoices.id)).where(eq(invoices.id, id));
    return r ?? null;
}
export async function listReservedAttempts(db: Db) {
    const rows = await db.select({ reservationId: issuedInvoices.id, invoiceId: invoices.id, status: invoices.status, cuit: issuedInvoices.cuit, ptoVta: issuedInvoices.ptoVta, cbteTipo: issuedInvoices.cbteTipo, cbteNro: issuedInvoices.cbteNro, importeTotalCentavos: issuedInvoices.importeTotalCentavos, approvalSnapshot: invoices.approvalSnapshot }).from(issuedInvoices).innerJoin(invoices, eq(issuedInvoices.invoiceId, invoices.id)).where(isNull(issuedInvoices.cae)).orderBy(issuedInvoices.createdAt);
    const closures = await db.select().from(auditLog).where(eq(auditLog.action, "reservation_closed_no_record"));
    return rows.map(({ approvalSnapshot, reservationId, ...r }) => {
        const closure = closures.find(entry => {
            const p = entry.payload as Record<string, unknown> | null;
            return entry.invoiceId === r.invoiceId && p?.reservationId === reservationId && p?.cuit === r.cuit && p?.ptoVta === r.ptoVta && p?.cbteTipo === r.cbteTipo && p?.cbteNro === r.cbteNro && p?.code === "602" && typeof p?.checkedAt === "string" && Number.isFinite(Date.parse(p.checkedAt));
        });
        const closedNoRecordAt = closure ? (closure.payload as { checkedAt: string }).checkedAt : undefined;
        return { ...r, canConsult: !closedNoRecordAt && trusted({ ...r, approvalSnapshot }), ...(closedNoRecordAt ? { closedNoRecordAt } : {}) };
    });
}
const sharedAttempts = new Map<string, Attempt>();
export function consultReservedInvoice(db: Db, env: Record<string, string | undefined>, id: string) { return createInvoiceConsultation({ env, repository: new DrizzleCredentialsRepository(db), store: new DrizzleTaCacheStore(db), getReservation: id => loadReservedInvoice(db, id), attempts: sharedAttempts })(id); }
