"use client";
import React, { useState } from "react";
import { Minus, Plus, RotateCw, RotateCcw } from "lucide-react";
export default function ReceiptViewer({rowId}: {rowId:string}) {
 const [zoom,setZoom] = useState(1);
 const [rotation,setRotation] = useState(0);
 const [ratio,setRatio] = useState(1.4);
 const [state,setState] = useState<"loading" | "ready" | "error">("loading");
 return <section className="receipt-viewer" aria-label="Imagen del comprobante">
  <div className="viewer-toolbar"><strong>VISTA DEL COMPROBANTE</strong><div className="viewer-controls">
   <button type="button" aria-label="Reducir imagen" disabled={state!=="ready" || zoom<=0.5} onClick={()=>setZoom(z=>Math.max(0.5,z-0.25))}><Minus size={15} aria-hidden="true" /></button>
   <button type="button" aria-label="Ampliar imagen" disabled={state!=="ready" || zoom>=3} onClick={()=>setZoom(z=>Math.min(3,z+0.25))}><Plus size={15} aria-hidden="true" /></button>
   <button type="button" aria-label="Girar imagen 90 grados" disabled={state!=="ready"} onClick={()=>setRotation(r=>(r+90)%360)}><RotateCw size={15} aria-hidden="true" /></button>
   <button type="button" aria-label="Restablecer imagen" disabled={state!=="ready"} onClick={()=>{setZoom(1);setRotation(0);}}><RotateCcw size={15} aria-hidden="true" /></button>
  </div></div>
  <div className="viewer-stage">
   {state==="loading" && <p role="status">Cargando imagen original…</p>}
   {state==="error" ? <div className="failed-state"><strong>Imagen no disponible</strong><p>No se pudo recuperar el archivo original. Puede no estar almacenado o no estar disponible en este momento.</p><button type="button" onClick={()=>setState("loading")}>Reintentar</button></div> :
    /* Private authenticated route; Next Image optimization must not cache receipt bytes. */
    /* eslint-disable-next-line @next/next/no-img-element */
    <div className="receipt-canvas" style={{width:(rotation%180?280*ratio:280)*zoom,height:(rotation%180?280:280*ratio)*zoom,display:state==="loading"?"none":undefined}}><img className="receipt-image" src={`/api/rows/${rowId}/image`} alt="Comprobante original cargado" onLoad={event=>{setRatio(event.currentTarget.naturalHeight/event.currentTarget.naturalWidth);setState("ready");}} onError={()=>setState("error")} style={{transform:`translate(-50%, -50%) rotate(${rotation}deg) scale(${zoom})`}} /></div>}
  </div><div className="viewer-hint">Imagen original · {Math.round(zoom*100)} % · {rotation}°</div>
 </section>;
}
