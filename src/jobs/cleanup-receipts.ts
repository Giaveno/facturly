import { inngest } from "@/lib/inngest/client";
import { getDb } from "@/lib/db/client";
import { LocalReceiptStorage } from "@/adapters/storage/local-receipt-storage";
import { retryReceiptCleanup } from "@/lib/review/delete";

/** Storage-only recovery: deliberately independent of fiscal emission configuration. */
export const cleanupReceiptsJob = inngest.createFunction(
  {id: "receipts/cleanup", triggers: [{cron: "*/15 * * * *"}], retries: 3},
  async ({step}) => step.run("cleanup-receipts", () => retryReceiptCleanup(getDb(), new LocalReceiptStorage())),
);
