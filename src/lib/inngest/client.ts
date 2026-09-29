import { Inngest } from "inngest";

/**
 * Inngest client (single instance shared by all jobs).
 *
 * The signing key is passed explicitly so the emission + OCR endpoints always
 * verify webhook signatures. The loud production assertion (refuse when the key
 * is missing or `INNGEST_DEV` is set) lives in `@/lib/inngest/config` and is
 * enforced at REQUEST time by the Inngest route — a module-load throw would also
 * fire during `next build` (route modules are evaluated to collect page data)
 * where the key is not present.
 *
 * Jobs are registered as thin adapters over offline-tested services; the Inngest
 * functions themselves are not exercised in the offline suite (they require the
 * Inngest dev server / event system). Their business logic is fully covered by
 * the services they delegate to (`processOcrRow`, `emitBatch`).
 */
export const inngest = new Inngest({
  id: "facturas-arca",
  signingKey: process.env.INNGEST_SIGNING_KEY,
});
