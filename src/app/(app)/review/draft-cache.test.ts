import { afterEach, expect, it } from "vitest";
import { removeReviewDraft, clearReviewDrafts, retainReviewDrafts, restoreReviewDrafts } from "./draft-cache";
afterEach(clearReviewDrafts);
it("restores dirty drafts after client-route unmount and history Back/Forward remount without browser storage",()=>{
 const draft={name:"Unsaved payer",cuit:"30710145764",amount:"100.00",date:"2026-10-28"};
 retainReviewDrafts({row:draft},{row:true});
 const remounted=restoreReviewDrafts(["row"]);expect(remounted.drafts.row).toEqual(draft);expect(remounted.editing.row).toBe(true);
 remounted.drafts.row!.name="Changed copy";expect(restoreReviewDrafts(["row"]).drafts.row!.name).toBe("Unsaved payer");
});
it("isolates rows not present in the current authenticated read model and clears on deliberate discard",()=>{
 retainReviewDrafts({other:{name:"Payer",cuit:"",amount:"",date:""}},{other:true});expect(restoreReviewDrafts(["current"]).drafts).toEqual({});clearReviewDrafts();expect(restoreReviewDrafts(["other"]).drafts).toEqual({});
});

it("forgets only the deleted receipt and retains other unsaved corrections",()=>{
 const draft={name:"Unsaved payer",cuit:"",amount:"10.00",date:"2026-10-28"};
 retainReviewDrafts({deleted:draft,survivor:draft},{deleted:true,survivor:true});removeReviewDraft("deleted");
 expect(restoreReviewDrafts(["deleted","survivor"])).toEqual({drafts:{survivor:draft},editing:{survivor:true}});
});
