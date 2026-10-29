import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth/session",async original=>({...await original<typeof import("@/lib/auth/session")>(),requireAccountantSession:vi.fn()}));
vi.mock("@/lib/db/client",()=>({getDb:vi.fn()}));
vi.mock("@/lib/review/image",()=>({loadReceiptImage:vi.fn()}));
import { requireAccountantSession, UnauthorizedError } from "@/lib/auth/session";
import { loadReceiptImage } from "@/lib/review/image";
import { GET } from "./route";
const id="00000000-0000-4000-8000-000000000000"; const params=(value=id)=>({params:Promise.resolve({id:value})});
describe("private row image",()=>{
 beforeEach(()=>{vi.clearAllMocks();vi.mocked(requireAccountantSession).mockResolvedValue();});
 it("rejects traversal IDs",async()=>{expect((await GET(new Request("http://app.test"),params("../secret"))).status).toBe(400);expect(loadReceiptImage).not.toHaveBeenCalled();});
 it("requires authentication before image lookup",async()=>{vi.mocked(requireAccountantSession).mockRejectedValue(new UnauthorizedError());expect((await GET(new Request("http://app.test"),params())).status).toBe(401);expect(loadReceiptImage).not.toHaveBeenCalled();});
 it("serves sniffed bytes privately, ignores arbitrary query keys",async()=>{vi.mocked(loadReceiptImage).mockResolvedValue({bytes:new Uint8Array([255,216,255]),mime:"image/jpeg"}); const res=await GET(new Request("http://app.test?key=../../secret"),params()); expect(loadReceiptImage).toHaveBeenCalledWith(undefined,id);expect(res.headers.get("content-type")).toBe("image/jpeg");expect(res.headers.get("cache-control")).toContain("no-store");expect(res.headers.get("x-content-type-options")).toBe("nosniff");});
 it("returns honest non-cacheable missing image",async()=>{vi.mocked(loadReceiptImage).mockResolvedValue(null);const res=await GET(new Request("http://app.test"),params());expect(res.status).toBe(404);expect(res.headers.get("cache-control")).toContain("no-store");});
});
