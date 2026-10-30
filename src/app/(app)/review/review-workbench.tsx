"use client";
import Link from "next/link";
import { FileText, LockKeyhole } from "lucide-react";
import React, { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ReviewInvoiceRow } from "@/lib/review/read-model";
import { formatCentavos, parseToCentavos } from "@/domain/money";
import ReceiptViewer from "./receipt-viewer";
import FiscalPreview from "./fiscal-preview";
import { isEditable, reviewBlockReason, statusLabel } from "./workbench-state";
import { removeReviewDraft, clearReviewDrafts, retainReviewDrafts, restoreReviewDrafts, type ReviewDraft } from "./draft-cache";
import "./review-workbench.css";

type Draft = ReviewDraft;
const money = (amount:number) => new Intl.NumberFormat("es-AR",{style:"currency",currency:"ARS"}).format(amount/100);
const fromRow = (row:ReviewInvoiceRow):Draft => ({name:row.fields.name,cuit:row.cuit??"",date:row.fields.date,amount:formatCentavos(row.fields.amount),recipientMode:row.recipientMode,taxRate:row.taxRate === null ? "" : String(row.taxRate)});

export default function ReviewWorkbench({rows,environment}: {rows:ReviewInvoiceRow[];environment:"production"|"homologacion"}) {
 const router = useRouter();
 const [deletedRows,setDeletedRows] = useState<string[]>([]);
 const [deletionNotice,setDeletionNotice] = useState("");
 const [selected,setSelected] = useState(rows[0]?.rowId??"");
 const [issuer,setIssuer] = useState("all");
 const [query,setQuery] = useState("");
 const [filter,setFilter] = useState("all");
 const [mode,setMode] = useState("details");
 const [drafts,setDrafts] = useState<Record<string,Draft>>({});
 const [editing,setEditing] = useState<Record<string,boolean>>({});
 const [cacheRestored,setCacheRestored] = useState(false);
 const [busy,setBusy] = useState(false);
 const [refreshing,startTransition] = useTransition();
 const [message,setMessage] = useState<{rowId:string;text:string}|null>(null);
 const approval = useRef<HTMLDialogElement>(null);
 const [approvalRow,setApprovalRow] = useState<string|null>(null);
 const pending = busy || refreshing;
 const visible = rows.filter(r=>!deletedRows.includes(r.rowId) && (issuer==="all" || r.clientId===issuer) && `${r.fields.name} ${r.cuit??""} ${r.rowId} ${r.razonSocial}`.toLocaleLowerCase("es-AR").includes(query.toLocaleLowerCase("es-AR")) && (filter==="all" || (filter==="reviewed" ? r.invoiceStatus==="REVIEWED" : r.invoiceStatus==="PENDING")));
 const row = visible.find(r=>r.rowId===selected) ?? visible[0];
 const dirtyIds = Object.keys(drafts).filter(id=>{if(deletedRows.includes(id))return false;const original=rows.find(r=>r.rowId===id);return original && JSON.stringify(drafts[id])!==JSON.stringify(fromRow(original));});
 const hasDirty = dirtyIds.length>0;
 useEffect(()=>{
  if (cacheRestored)return;
  const retained=restoreReviewDrafts(rows.map(item=>item.rowId));
  setDrafts(retained.drafts);setEditing(retained.editing);setCacheRestored(true);
 },[rows,cacheRestored]);
 useEffect(()=>{if(cacheRestored)retainReviewDrafts(drafts,editing);},[drafts,editing,cacheRestored]);
 useEffect(()=>{
  if (!hasDirty) return;
  const beforeUnload=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue="";};
  const beforeNavigation=(event:MouseEvent)=>{const anchor=event.target instanceof Element ? event.target.closest("a[href]") : null;if(anchor){if(!window.confirm("Hay correcciones sin guardar. ¿Desea salir y descartarlas?")){event.preventDefault();event.stopPropagation();}else{clearReviewDrafts();}}};
  window.addEventListener("beforeunload",beforeUnload);
  document.addEventListener("click",beforeNavigation,true);
  return ()=>{window.removeEventListener("beforeunload",beforeUnload);document.removeEventListener("click",beforeNavigation,true);};
 },[hasDirty]);
 function update(key:keyof Draft,value:string) { if(!row)return;setDrafts(current=>({...current,[row.rowId]:{...(current[row.rowId]??fromRow(row)),[key]:value,...(key === "recipientMode" ? {cuit:""} : {})}})); }
 function cancel() {if(!row)return;if(dirtyIds.includes(row.rowId)&&!window.confirm("¿Descartar las correcciones sin guardar de este comprobante?"))return;setDrafts(current=>{const next={...current};delete next[row.rowId];return next;});setEditing(current=>({...current,[row.rowId]:false}));}
 async function run(path:string,body:unknown,success:string):Promise<boolean> {
  if(!row || pending)return false;
  const rowId=row.rowId;setBusy(true);setMessage(null);
  try {
   const response=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
   if(!response.ok){const result=await response.json().catch(()=>({}));setMessage({rowId,text:(path.endsWith("/corrections") || response.status===409)&&typeof result.error==="string"?result.error:response.status===409?"El comprobante cambió o no está listo para esta acción. Actualice los datos y vuelva a revisar.":response.status===401?"La sesión venció. Inicie sesión nuevamente.":"No se pudo completar la acción. Revise los datos e intente nuevamente."});return false;}
   setMessage({rowId,text:success});startTransition(()=>router.refresh());return true;
  } catch {setMessage({rowId,text:"No se pudo conectar con el servicio. Intente nuevamente."});return false;}
  finally {setBusy(false);}
 }
 async function save() {
  if(!row)return;const draft=drafts[row.rowId]??fromRow(row);
  let amount:number;try{amount=parseToCentavos(draft.amount.replace(",","."));}catch{setMessage({rowId:row.rowId,text:"Ingrese un importe válido, sin separador de miles y con hasta dos decimales."});return;}
  if(await run(`/api/rows/${row.rowId}/corrections`,{...draft,recipientMode:draft.recipientMode??row.recipientMode,taxRate:draft.taxRate ? Number(draft.taxRate) : null,cuit:draft.cuit.replace(/[ -]/g,""),amount},"Correcciones guardadas. La revisión todavía no está confirmada.")){
   setEditing(current=>({...current,[row.rowId]:false}));setDrafts(current=>{const next={...current};delete next[row.rowId];return next;});
  }
 }
 async function permanentlyDelete() {
  if (!row || pending || !["PENDING","REVIEWED","REJECTED"].includes(row.invoiceStatus)) return;
  const target = row; // Capture identity before confirmation and asynchronous work.
  if (!window.confirm(`Eliminar definitivamente el comprobante ${target.rowId.slice(0,8)}\nEmpresa: ${target.razonSocial}\nDestinatario: ${target.fields.name || "Sin identificar"}\nFecha: ${target.fields.date || "Sin identificar"} · Importe: ${money(target.fields.amount)}\n\nEsta acción es irreversible. Se eliminarán los datos extraídos y las facturas no fiscales asociadas. La imagen se eliminará si ningún otro comprobante la utiliza. Se conservará el historial de auditoría. ¿Desea continuar?`)) return;
  setBusy(true);setMessage(null);setDeletionNotice("");
  try {
   const response = await fetch(`/api/rows/${target.rowId}`, {method:"DELETE"});
   const result = await response.json().catch(()=>null);
   if (!response.ok) {
    setMessage({rowId:target.rowId,text:response.status===409?"No se puede eliminar: el comprobante tiene actividad fiscal o cambió de estado. Actualice los datos.":response.status===401?"La sesión venció. Inicie sesión nuevamente.":"No se pudo eliminar el comprobante. Intente nuevamente."});return;
   }
   if (!result || !["complete","pending"].includes(result.cleanup)) {
    setMessage({rowId:target.rowId,text:"No se pudo confirmar el resultado. Actualice los datos antes de volver a intentar."});return;
   }
   removeReviewDraft(target.rowId);
   setDrafts(current=>{const next={...current};delete next[target.rowId];return next;});
   setEditing(current=>{const next={...current};delete next[target.rowId];return next;});
   setDeletedRows(current=>[...current,target.rowId]);
   setSelected(visible.find(item=>item.rowId!==target.rowId)?.rowId??"");
   setDeletionNotice(result.cleanup==="pending"?"Los datos del comprobante se eliminaron. La eliminación del archivo está pendiente y se reintentará automáticamente; todavía no se puede confirmar su eliminación definitiva.":"Comprobante eliminado definitivamente. Las imágenes compartidas con otros comprobantes y el historial de auditoría se conservaron.");
   startTransition(()=>router.refresh());
  } catch {setMessage({rowId:target.rowId,text:"No se pudo confirmar la eliminación. Actualice los datos y vuelva a intentar."});}
  finally {setBusy(false);}
 }
 function reject() {if(!row)return;const reason=window.prompt("Motivo del rechazo (obligatorio)");if(reason===null)return;if(!reason.trim()){setMessage({rowId:row.rowId,text:"Ingrese un motivo de rechazo."});return;}void run(`/api/invoices/${row.invoiceId}/reject`,{reason},"Comprobante rechazado; no se emitirá.");}
 const emitRow=rows.find(r=>r.rowId===approvalRow);
 const environmentLabel=environment==="production"?"Producción":"Homologación";
 const issuerList=[...new Map(rows.map(r=>[r.clientId,r])).values()];
 return <main className="page-content review-page">
  <div className="page-heading review-heading"><div><p className="eyebrow">01 / Flujo de trabajo</p><h1>Revisión de comprobantes</h1><p className="lede">Revisión de información, correcciones y confirmación antes de aprobar.</p></div><div className="heading-actions"><label className="issuer-select"><span>Empresa emisora</span><select value={issuer} disabled={pending} onChange={e=>setIssuer(e.target.value)}><option value="all">Todas las empresas</option>{issuerList.map(r=><option key={r.clientId} value={r.clientId}>{r.razonSocial} · CUIT {r.issuerCuit} · PV {r.ptoVta}</option>)}</select></label><Link className="btn" href="/">+ Nueva carga</Link></div></div>
  {deletionNotice && <p className="draft-notice" role="status">{deletionNotice}</p>}
  {hasDirty && <p className="draft-notice" role="status">{dirtyIds.length} comprobante(s) con cambios sin guardar. Los borradores se conservan al cambiar de comprobante o filtro.</p>}
  <div className="review-workbench"><aside className="queue" aria-label="Cola de revisión"><div className="queue-top"><div className="queue-title"><strong>Bandeja de trabajo</strong><span>{visible.length}</span></div><label className="search-field"><span className="sr-only">Buscar comprobante</span><input type="search" placeholder="Buscar comprobante…" value={query} disabled={pending} onChange={e=>setQuery(e.target.value)} /></label><div className="queue-filter" aria-label="Filtrar por estado">{([["all","Todos"],["pending","Pendientes de revisión"],["reviewed","Revisados"]] as const).map(([value,label])=><button type="button" key={value} className={`filter-pill ${filter===value?"active":""}`} aria-pressed={filter===value} disabled={pending} onClick={()=>setFilter(value)}>{label}</button>)}</div></div><div className="queue-list" role="region" aria-label="Comprobantes de la bandeja" tabIndex={0}>{visible.map((item,index)=><button type="button" key={item.rowId} className={`queue-item ${row?.rowId===item.rowId?"active":""}`} aria-pressed={row?.rowId===item.rowId} disabled={pending} onClick={()=>setSelected(item.rowId)}><div className="queue-row"><span className="queue-id">{index+1} / {visible.length}</span><span className={`status-pill ${item.invoiceStatus==="REVIEWED"?"status-ready":"status-muted"}`}>{statusLabel(item)}</span></div><strong>{item.recipientMode === "consumer_final" ? "Consumidor Final" : item.fields.name || "Sin destinatario identificado"}</strong><div className="queue-sub">{item.razonSocial}</div><div className="queue-sub">{item.fields.date || "Fecha sin identificar"}{dirtyIds.includes(item.rowId)?" · Sin guardar":""}</div><div className="queue-amount">{item.fields.amount>0?money(item.fields.amount):"Importe sin extraer"}</div></button>)}{!visible.length&&<p className="queue-empty">No hay comprobantes para este filtro.</p>}</div><div className="queue-footer">Guardar ≠ confirmar revisión ≠ aprobar</div></aside>
  {row?<div className={`work-area ${mode==="image"?"image-mode":""}`}><div className="work-top"><div className="work-identity"><span className="work-identity-icon" aria-hidden="true"><FileText size={18} strokeWidth={1.6} aria-hidden="true" /></span><span><strong>Comprobante {row.rowId.slice(0,8)}</strong><small>Emisor: {row.razonSocial}</small></span></div><div className="work-top-right"><span className="status-pill status-muted">{statusLabel(row)}</span><div className="mobile-work-tabs" aria-label="Vista del comprobante"><button type="button" className={mode==="image"?"active":""} aria-pressed={mode==="image"} onClick={()=>setMode("image")}>Imagen</button><button type="button" className={mode==="details"?"active":""} aria-pressed={mode==="details"} onClick={()=>setMode("details")}>Datos</button></div></div></div><div className="work-content"><ReceiptViewer key={row.rowId} rowId={row.rowId}/><section className="review-details" aria-label="Datos extraídos"><div className="detail-body"><div className="detail-kicker"><span className="tiny-label">REVISIÓN DE DATOS</span></div><h2>{row.recipientMode === "consumer_final" ? "Consumidor Final" : row.fields.name||"Destinatario sin identificar"}</h2><div className="detail-summary">La empresa emisora y el destinatario son entidades distintas.</div><div className="issuer-block"><div><div className="issuer-caption">EMPRESA EMISORA · NO ES EL DESTINATARIO</div><strong>{row.razonSocial}</strong><small>CUIT {row.issuerCuit} · Punto de venta {String(row.ptoVta).padStart(4,"0")}</small></div><span className="lock-icon" aria-label="Emisor definido al cargar"><LockKeyhole size={16} strokeWidth={1.6} aria-hidden="true" /></span></div>
   {row.status==="PENDING"||row.failed?<div className="failed-state"><h3>{row.failed?"No se pudieron extraer los datos":"Esperando datos extraídos"}</h3><p>{reviewBlockReason(row)}</p><button type="button" className="btn" disabled={pending} onClick={()=>startTransition(()=>router.refresh())}>Actualizar estado</button></div>:<><div className="detail-section-title">Destinatario / receptor</div><div className="field full"><label className="field-label" htmlFor="recipient-mode">Modo de destinatario</label>{editing[row.rowId]&&isEditable(row)?<select id="recipient-mode" value={(drafts[row.rowId]??fromRow(row)).recipientMode??row.recipientMode} disabled={pending} onChange={e=>update("recipientMode",e.target.value)}><option value="consumer_final">Consumidor Final</option><option value="identified">Facturar a un CUIT</option></select>:<div className="read-value">{row.recipientMode === "consumer_final" ? "Consumidor Final" : "Facturar a un CUIT"}</div>}<p className="source-note">{row.recipientModeSource === "upload_default" ? "Modo predeterminado de la carga; no proviene del OCR." : row.recipientModeSource === "manual" ? "Modo seleccionado manualmente." : "Modo conservado por migración; requiere nueva revisión."} El CUIT se clasifica en Padrón al aprobar; si no se puede verificar, la aprobación se bloquea. Sin identificar: solo importes menores a $10.000.000. Para deducciones que requieren CUIT, no use el modo anónimo.</p></div><div className="detail-fields">{([['name','Nombre o razón social'],['cuit','CUIT del destinatario'],['date','Fecha del comprobante'],['amount','Importe total (ARS)']] as const).map(([key,label])=>{
    const draft=drafts[row.rowId]??fromRow(row);if(key==="cuit" && (editing[row.rowId] ? draft.recipientMode??row.recipientMode : row.recipientMode)==="consumer_final")return null;const manual=row.manualFields.includes(key)||(key==="cuit"&&row.cuitSource==="manual");
    return <div className={`field ${key==="name"?"full":""}`} key={key}><label className="field-label" htmlFor={`review-${key}`}>{key === "name" && row.recipientMode === "consumer_final" ? "Nombre extraído (solo referencia, no receptor fiscal)" : label}</label>{editing[row.rowId]&&isEditable(row)?<input id={`review-${key}`} type={key==="date"?"date":"text"} inputMode={key==="amount"?"decimal":key==="cuit"?"numeric":undefined} maxLength={key==="name"?200:key==="cuit"?13:undefined} value={draft[key]} disabled={pending} onChange={e=>update(key,e.target.value)}/>:<div id={`review-${key}`} className={`read-value ${key==="amount"?"amount":""}`}>{key==="amount"?money(row.fields.amount):key==="cuit"?(row.cuit||"Sin identificar"):row.fields[key]||"Sin identificar"}</div>}<div className="source-note">{manual?"Origen: corrección manual":key==="cuit"&&row.cuitSource==="registry"?"Origen: registro de pagadores":"Origen: OCR"}</div></div>;
   })}{row.issuerCondition === "ri" && <div className="field"><label className="field-label" htmlFor="tax-rate">IVA de venta (productos gravados)</label>{editing[row.rowId]?<select id="tax-rate" value={(drafts[row.rowId]??fromRow(row)).taxRate??""} disabled={pending} onChange={e=>update("taxRate",e.target.value)}><option value="">Seleccione la alícuota</option><option value="10.5">10,5%</option><option value="21">21%</option><option value="27">27%</option></select>:<div className="read-value">{row.taxRate === null ? "Sin seleccionar" : `${row.taxRate}%`}</div>}<div className="source-note">Selección fiscal manual, no inferida del importe ni del OCR.</div></div>}<div className="field"><span className="field-label">Tipo de factura</span><div className="read-value">Se define al aprobar</div><div className="source-note">Según condición de IVA en ARCA; no es un dato de la imagen.</div></div></div><p className="source-note">Solo productos (Concepto 1). No apruebe servicios, operaciones exentas ni ventas con tasas mixtas en este flujo.</p><p className="source-note">La fecha del comprobante no define la fecha de emisión fiscal.</p></>}
   {row.invoiceStatus === "REVIEWED" && !editing[row.rowId] && <FiscalPreview row={row} environment={environment} />}
   {editing[row.rowId]?<div className="detail-alert"><div><strong>Edición de datos</strong><p>Revise todos los campos. Guardar conserva las correcciones y deja pendiente una nueva confirmación de revisión.</p></div></div>:reviewBlockReason(row)&&<div className="detail-alert"><div><strong>No se puede confirmar</strong><p>{reviewBlockReason(row)}</p></div></div>}
   {message?.rowId===row.rowId&&<p className="action-feedback" role="status">{message.text}</p>}
   </div><div className="detail-actions">{isEditable(row)?editing[row.rowId]?<><button type="button" className="btn btn-quiet" disabled={pending} onClick={cancel}>Cancelar</button><button type="button" className="btn btn-primary" disabled={pending} onClick={()=>void save()}>Guardar correcciones</button></>:<><button type="button" className="btn btn-quiet" disabled={pending} onClick={()=>{setEditing(current=>({...current,[row.rowId]:true}));setDrafts(current=>({...current,[row.rowId]:current[row.rowId]??fromRow(row)}));}}>Editar datos</button><button type="button" className="btn" disabled={pending || !!reviewBlockReason(row) || row.invoiceStatus!=="PENDING"} onClick={()=>void run(`/api/invoices/${row.invoiceId}/review`,undefined,"Revisión confirmada. La emisión todavía no fue aprobada.")}>Confirmar revisión</button><button type="button" className="btn btn-primary" disabled={pending || !!reviewBlockReason(row) || row.invoiceStatus!=="REVIEWED"} title={row.invoiceStatus!=="REVIEWED"?"Primero debe confirmar la revisión":undefined} onClick={()=>{setApprovalRow(row.rowId);approval.current?.showModal();}}>Aprobar</button><button type="button" className="btn btn-danger" disabled={pending} onClick={reject}>Rechazar</button></>:<><span className="detail-actions-note">{statusLabel(row)} · Edición no disponible</span>{["PENDING","REVIEWED"].includes(row.invoiceStatus)&&<button type="button" className="btn btn-danger" disabled={pending} onClick={reject}>Rechazar</button>}</>}<button type="button" className="btn btn-danger" disabled={pending || !["PENDING","REVIEWED","REJECTED"].includes(row.invoiceStatus)} title={["PENDING","REVIEWED","REJECTED"].includes(row.invoiceStatus)?"Eliminar datos y archivo sin posibilidad de recuperación":"No se puede eliminar un comprobante con actividad fiscal"} onClick={()=>void permanentlyDelete()}>Eliminar definitivamente</button>{pending&&<span className="detail-actions-note" role="status">Procesando…</span>}</div></section></div></div>:<div className="work-area"><div className="work-empty"><h2>{rows.length?"No hay comprobantes en esta selección":"No hay comprobantes para revisar"}</h2><p>{rows.length?"Cambie la empresa o el filtro de búsqueda.":"Los comprobantes cargados aparecerán en esta bandeja."}</p><Link href="/">Cargar comprobantes</Link></div></div>}
  </div>
  <dialog ref={approval} className="approval-dialog" aria-labelledby="approval-title" onCancel={()=>setApprovalRow(null)}><h2 id="approval-title">Aprobar para emisión</h2><p>Esta acción puede iniciar una emisión fiscal en ARCA.</p>{emitRow&&<dl><dt>Empresa emisora</dt><dd>{emitRow.razonSocial}<small>CUIT {emitRow.issuerCuit} · Punto de venta {String(emitRow.ptoVta).padStart(4,"0")}</small></dd><dt>Destinatario</dt><dd>{emitRow.recipientMode === "consumer_final" ? "Consumidor Final" : emitRow.fields.name}<small>{emitRow.recipientMode === "consumer_final" ? "Sin identificar (documento 99 / 0)" : `CUIT ${emitRow.cuit}`}</small></dd><dt>Importe total</dt><dd>{money(emitRow.fields.amount)}</dd><dt>IVA de venta</dt><dd>{emitRow.issuerCondition === "ri" ? `${emitRow.taxRate}%` : "No corresponde (Factura C)"}</dd><dt>Concepto</dt><dd>Productos</dd><dt>Entorno fiscal</dt><dd>{environmentLabel}</dd></dl>}<div className="detail-alert">{environment==="production"?"Producción: puede generar una factura fiscal real.":"Homologación: se utilizarán los servicios de prueba de ARCA."} La aprobación no garantiza la emisión; el resultado se mostrará en Facturas.</div>{emitRow && <FiscalPreview row={emitRow} environment={environment} />}<div className="approval-actions"><button type="button" className="btn" autoFocus onClick={()=>{approval.current?.close();setApprovalRow(null);}}>Cancelar</button><button type="button" className="btn btn-primary" disabled={pending||!emitRow||emitRow.rowId!==row?.rowId} onClick={()=>{approval.current?.close();setApprovalRow(null);if(emitRow)void run(`/api/invoices/${emitRow.invoiceId}/approve`,{expected:{rowId:emitRow.rowId,name:emitRow.fields.name,cuit:emitRow.recipientMode === "identified" ? emitRow.cuit : "",date:emitRow.fields.date,amount:emitRow.fields.amount,issuerCuit:emitRow.issuerCuit,issuerName:emitRow.razonSocial,issuerCondition:emitRow.issuerCondition,recipientMode:emitRow.recipientMode,taxRate:emitRow.taxRate,ptoVta:emitRow.ptoVta,environment}},"Aprobado. La emisión está en proceso; consulte el resultado en Facturas.");}}>Confirmar aprobación</button></div></dialog>
 </main>;
}
