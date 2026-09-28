import { Inngest } from "inngest";

/**
 * Inngest client (single instance shared by all jobs).
 *
 * Jobs are registered as thin adapters over offline-tested services; the Inngest
 * functions themselves are not exercised in the offline suite (they require the
 * Inngest dev server / event system). Their business logic is fully covered by
 * the services they delegate to (`processOcrRow`, `emitBatch`).
 */
export const inngest = new Inngest({ id: "facturas-arca" });
