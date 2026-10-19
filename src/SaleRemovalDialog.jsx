import React,{useState} from 'react';
import {api} from './api.js';
import {RecordDialog} from './LedgerRecords.jsx';

export default function SaleRemovalDialog({order,index,onClose,onSaved,onRemoved}){
  const whole=index==null||order.lines.length===1;
  const rows=order.lines.map((line,index)=>({...line,index})).filter(line=>whole||line.index===index);
  const [choices,setChoices]=useState({}),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const chooseAll=restock=>setChoices(Object.fromEntries(rows.filter(line=>line.variantId).map(line=>[line.index,restock])));
  const ready=rows.every(line=>!line.variantId||typeof choices[line.index]==='boolean');
  const submit=async event=>{
    event.preventDefault();if(!ready)return;setBusy(true);setError('');
    try{
      const restockChoices=rows.filter(line=>line.variantId).map(line=>({index:line.index,restock:choices[line.index]}));
      const body={expectedUpdatedAt:order.updatedAt,restockChoices};
      if(!whole){
        body.lines=order.lines.map((line,originalIndex)=>({...line,originalIndex})).filter(line=>line.originalIndex!==index);
        const oldBase=(order.netSales||0)+(order.shippingRevenue||0);
        const newBase=body.lines.reduce((sum,line)=>sum+(line.net||0),0)+(order.shippingRevenue||0);
        body.taxes=oldBase>0?Math.round(((order.taxes||0)*newBase/oldBase+Number.EPSILON)*100)/100:0;
      }
      const result=await api(`/api/manual-sales/${order._id}`,{method:whole?'DELETE':'PATCH',body:JSON.stringify(body)});
      if(whole)onRemoved();else onSaved(result);
    }catch(error){setError(error.message);}finally{setBusy(false);}
  };
  return <RecordDialog title={whole?'Cancel / remove sale':'Remove sale item'} onClose={onClose} busy={busy} onSubmit={submit}>
    <p>{whole?'This removes the sale from your orders and reports.':'This removes this item and recalculates the sale totals.'} Choose which items to return to inventory.</p>
    {order.lines.length===1&&index!=null&&<p className="record-help">This is the last item, so removing it removes the entire sale.</p>}
    {error&&<div className="notice" role="alert">{error}</div>}
    <fieldset className="record-fieldset" disabled={busy}>
      <div className="actions"><button type="button" className="secondary" onClick={()=>chooseAll(true)}>Return all to inventory</button><button type="button" className="secondary" onClick={()=>chooseAll(false)}>Return none</button></div>
      {rows.map(line=><div className="sale-line-card" key={line.index}><strong>{line.title}</strong><div className="small">{[line.variantTitle,line.sku].filter(Boolean).join(' · ')} · Qty {line.quantity}</div>
        {line.variantId?<label className="field"><span>Return {line.quantity} to inventory?</span><select required aria-label={`Return ${line.title} to inventory`} value={choices[line.index]===undefined?'':String(choices[line.index])} onChange={event=>setChoices({...choices,[line.index]:event.target.value==='true'})}><option value="" disabled>Choose…</option><option value="true">Yes — add back to inventory</option><option value="false">No — leave inventory unchanged</option></select></label>:<p className="record-help">This item has no linked Shopify variant, so inventory cannot be returned automatically.</p>}
      </div>)}
    </fieldset>
    <div className="modal-actions"><button className="secondary" type="button" disabled={busy} onClick={onClose}>Keep {whole?'sale':'item'}</button><button className="danger" type="submit" disabled={busy||!ready}>{busy?'Removing…':whole?'Confirm cancel / remove sale':'Confirm remove item'}</button></div>
  </RecordDialog>;
}
