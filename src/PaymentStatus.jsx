import React,{useEffect,useState} from 'react';
import {api} from './api.js';
import {paymentStatus,paymentLabels} from './payment-status.js';

export default function PaymentStatus({order,onSaved}){
  const [record,setRecord]=useState(order),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{setRecord(order);},[order]);
  const status=paymentStatus(record),label=paymentLabels[status]||status.replaceAll('_',' ');
  const save=async event=>{
    const value=event.target.value;setBusy(true);setError('');
    try{
      const saved=await api(`/api/orders/${record._id}`,{method:'PATCH',body:JSON.stringify({paymentStatus:value||null,expectedUpdatedAt:record.updatedAt})});
      setRecord(saved);onSaved?.(saved);
    }catch(error){setError(error.message);}finally{setBusy(false);}
  };
  return <span className="payment-control" onClick={event=>event.stopPropagation()} onKeyDown={event=>event.stopPropagation()}>
    <select className={`payment-status ${status==='paid'?'is-paid':'is-unpaid'}`} aria-label={`Payment status for ${record.name||record.orderNumber}`} title={record.paymentStatus?'Manually set in pnlstore':'Imported status; select Paid or Unpaid to set manually'} disabled={busy} value={record.paymentStatus||''} onChange={save}>
      <option value="">{record.paymentStatus?(record.source==='shopify'?'Use Shopify status':'Not set'):label}</option><option value="paid">Paid</option><option value="unpaid">Unpaid</option>
    </select>
    {busy&&<small role="status">Saving…</small>}
    {error&&<small className="negative" role="alert">{error} <a href="/orders">Reload orders</a></small>}
  </span>;
}
