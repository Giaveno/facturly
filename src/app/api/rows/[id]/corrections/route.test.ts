import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth/session",async original=>({...await original<typeof import("@/lib/auth/session")>(),requireAccountantSession:vi.fn()}));
vi.mock("@/lib/db/client",()=>({getDb:vi.fn()}));
vi.mock("@/lib/review/corrections",async original=>({...await original<typeof import("@/lib/review/corrections")>(),saveCorrections:vi.fn()}));
import { requireAccountantSession, UnauthorizedError } from "@/lib/auth/session";
import { saveCorrections, CorrectionStateError, CorrectionNotFoundError } from "@/lib/review/corrections";
import { POST } from "./route";
const id="00000000-0000-4000-8000-000000000000";
const params=(value=id)=>({params:Promise.resolve({id:value})});
const req=(body:unknown={recipientMode:"identified",taxRate:21,name:"Payer",cuit:"30710145764",date:"2026-10-27",amount:100},origin="http://app.test")=>new Request("http://app.test/api",{method:"POST",headers:{host:"app.test","x-forwarded-proto":"http",origin,"Content-Type":"application/json"},body:JSON.stringify(body)});
describe("correction boundary",()=>{
 beforeEach(()=>{vi.clearAllMocks();vi.mocked(requireAccountantSession).mockResolvedValue();});
 it("validates UUID before auth",async()=>{expect((await POST(req(),params("../file"))).status).toBe(400);expect(requireAccountantSession).not.toHaveBeenCalled();});
 it("denies cross origin",async()=>{expect((await POST(req({},"http://evil.test"),params())).status).toBe(403);expect(saveCorrections).not.toHaveBeenCalled();});
 it("requires session",async()=>{vi.mocked(requireAccountantSession).mockRejectedValue(new UnauthorizedError());expect((await POST(req(),params())).status).toBe(401);expect(saveCorrections).not.toHaveBeenCalled();});
 it("rejects bad fields and malformed JSON without service calls",async()=>{expect((await POST(req({}),params())).status).toBe(400);expect((await POST(new Request("http://app.test/api",{method:"POST",headers:{host:"app.test","x-forwarded-proto":"http",origin:"http://app.test"},body:"{"}),params())).status).toBe(400);expect(saveCorrections).not.toHaveBeenCalled();});
 it("saves via real service contract",async()=>{vi.mocked(saveCorrections).mockResolvedValue({rowId:id,invoiceId:id,status:"CORRECTED",invoiceStatus:"PENDING"}); const res=await POST(req(),params());expect(res.status).toBe(200);expect((await res.json()).invoiceStatus).toBe("PENDING");});
 it.each([[new CorrectionStateError(),409],[new CorrectionNotFoundError(),404]] as const)("maps service errors",async(error,status)=>{vi.mocked(saveCorrections).mockRejectedValue(error);expect((await POST(req(),params())).status).toBe(status);});
});
