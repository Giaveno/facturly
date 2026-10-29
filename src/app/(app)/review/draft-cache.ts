export interface ReviewDraft {name:string;cuit:string;date:string;amount:string;recipientMode?:"consumer_final"|"identified";taxRate?:string}
interface DraftCache {drafts:Record<string,ReviewDraft>;editing:Record<string,boolean>}
// Transient tab memory only. Never put receipt/CUIT data into browser storage or history.
let retained:DraftCache={drafts:{},editing:{}};
export function retainReviewDrafts(drafts:DraftCache["drafts"],editing:DraftCache["editing"]):void {
 retained={drafts:structuredClone(drafts),editing:{...editing}};
}
export function restoreReviewDrafts(rowIds:string[]):DraftCache {
 const allowed=new Set(rowIds);
 return {drafts:Object.fromEntries(Object.entries(retained.drafts).filter(([id])=>allowed.has(id)).map(([id,draft])=>[id,{...draft}])),editing:Object.fromEntries(Object.entries(retained.editing).filter(([id])=>allowed.has(id)))};
}
export function clearReviewDrafts():void {retained={drafts:{},editing:{}};}

/** Forget only the deleted receipt; preserve unrelated unsaved work. */
export function removeReviewDraft(rowId: string): void {
 delete retained.drafts[rowId]; delete retained.editing[rowId];
}
