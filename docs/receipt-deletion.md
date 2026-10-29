# Permanent receipt deletion

The review workbench offers **Eliminar definitivamente** independently of editing, including pending/failed extraction and rejected invoices. Confirmation identifies the receipt and explains irreversible deletion, shared images, and retained audit history.

## Safety boundary

- The OCR row is the deletion identity. All associated invoices must be PENDING, REVIEWED, or REJECTED; any fiscal reservation blocks deletion, even without a CAE.
- The shared review row lock serializes approval, corrections, deletion, and OCR finalization. External OCR runs outside the lock; stale jobs cannot recreate a deleted row or linked audit.
- Associated nonfiscal invoices and OCR data are deleted. Photos, storage objects, and batches are removed only after their final reference disappears. Clients, payer registry, credentials, delegations, and fiscal reservations are not deleted.
- Audit event IDs, actor, action, and timestamps are retained. Affected foreign keys are detached and receipt-bearing payloads are replaced with minimal non-sensitive deleted entity IDs. The deletion event contains no image/OCR fields.

## Deploy manually

1. Review `drizzle/0006_receipt_cleanup.sql` and its metadata with the schema changes. Apply it through the normal migration workflow **before** deploying the endpoint/job. Do not use schema push in production. Implementation/tests do not apply migrations to any configured database.
2. Deploy the authenticated same-origin DELETE endpoint and the registered `receipts/cleanup` Inngest job together.
3. Ensure the signed Inngest endpoint and scheduler actually run. Pending file cleanup is retried every 15 minutes, independently of emission configuration. Without a running scheduler, pending tasks remain durable but will not automatically progress.
4. The current local storage adapter remains local-development only and refuses production. A production-compatible private receipt-storage adapter is required before production use; this feature does not remove that existing safeguard.

## Partial completion and recovery

A database transaction removes application records, redacts/detaches affected audit payloads, and enqueues file cleanup. Only after commit does it attempt storage deletion. Successful unlink completes the outbox item; failures/crashes leave it pending for idempotent retry. The endpoint returns HTTP 202 with `cleanup: pending` when unlink is not confirmed, and the UI explicitly says file deletion is still pending. It never reports confirmed permanent file deletion in that case. Shared images intentionally remain while other receipts reference them.

The worker rechecks live photo references before unlinking. Normal uploads use fresh random storage keys; arbitrary concurrent reuse of an old storage key by external writers is not a supported ingestion path. Storage deletion and database state cannot form one atomic transaction, so a crash after unlink but before marking completion causes a safe idempotent retry. The outbox never stores uploaded bytes or OCR fields.

## Verification

Offline service tests use synthetic PGlite databases and run the repository SQL migrations. They cover fiscal state/reservation guards, multiple invoices, shared references, audit redaction, rollback, cleanup failure/retry, stale/in-flight OCR, and review listing/approval races. Route tests mock auth/storage/database boundaries. Markup/CSS tests verify the deletion affordance and accessible scroll-region structure; they do not establish actual browser layout, scrolling, focus behavior, or live scheduler operation. Manually verify desktop/tablet vertical scrolling, mobile horizontal scrolling, keyboard access, and irreversible confirmation against disposable uploads before rollout.
