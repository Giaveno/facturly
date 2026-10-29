import { getDb } from "@/lib/db/client";
import { listReviewInvoices } from "@/lib/review/read-model";
import { resolveArcaEnvironment } from "@/lib/emission/environment";
import ReviewWorkbench from "./review-workbench";
export const dynamic = "force-dynamic";
export default async function ReviewPage() {
 const rows = await listReviewInvoices(getDb());
 return <ReviewWorkbench rows={rows} environment={resolveArcaEnvironment(process.env)} />;
}
