import React,{useEffect,useState} from 'react';
import {Plus,Trash2} from 'lucide-react';
import {api,money} from './api.js';
import {InputField,RecordDialog,SaveActions,SignInNotice} from './LedgerRecords.jsx';

const blankLine=()=>({title:'',variantTitle:'',sku:'',quantity:1,gross:0,discount:0,unitCost:0});
export default function ManualSaleEditor({record,onClose,onSaved}){
  const [access,setAccess]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [values,setValues]=useState(()=>({name:record?.name||'Manual sale',date:record?.createdAtShopify?.slice(0,10)||new Date().toISOString().slice(0,10),
    shippingRevenue:record?.shippingRevenue??0,taxes:record?.taxes??0,shippingCost:record?.shippingCost??0,paymentFees:record?.paymentFees??0,materialCost:record?.materialCost??0,otherVariableCost:record?.otherVariableCost??0,notes:record?.notes||''}));
  const [lines,setLines]=useState(()=>record?.lines?.map(line=>({...line}))||[blankLine()]);
  useEffect(()=>{api('/api/status').then(setAccess).catch(error=>setError(error.message));},[]);
  const change=(key,value)=>setValues({...values,[key]:value});
  const lineChange=(index,key,value)=>setLines(previous=>previous.map((line,i)=>i===index?{...line,[key]:value}:line));
  const save=async event=>{
    event.preventDefault();setBusy(true);setError('');
    try{
      const body={...values,lines:lines.map(line=>({...line,quantity:Number(line.quantity),gross:Number(line.gross),discount:Number(line.discount||0),unitCost:Number(line.unitCost||0)}))};
      if(record)body.expectedUpdatedAt=record.updatedAt;
      const result=await api(`/api/manual-sales${record?`/${record._id}`:''}`,{method:record?'PATCH':'POST',body:JSON.stringify(body)});onSaved(result);
    }catch(error){setError(error.message);}finally{setBusy(false);}
  };
  const net=lines.reduce((sum,line)=>sum+(Number(line.gross)||0)-(Number(line.discount)||0),0);
  const cogs=lines.reduce((sum,line)=>sum+(Number(line.unitCost)||0)*(Number(line.quantity)||0),0);
  const variable=['shippingCost','paymentFees','materialCost','otherVariableCost'].reduce((sum,key)=>sum+(Number(values[key])||0),0);
  const grossProfit=net+(Number(values.shippingRevenue)||0)-cogs-variable;
  return <RecordDialog title={record?'Edit manual sale':'Add manual sale'} onClose={onClose} busy={busy} onSubmit={save} wide>
    <SignInNotice access={access}/>{error&&<div className="notice" role="alert">{error}</div>}
    <fieldset className="record-fieldset" disabled={busy||!access?.ownerAuthenticated}>
      <div className="formgrid"><InputField field={{name:'name',label:'Sale name',required:true}} value={values.name} onChange={value=>change('name',value)}/><InputField field={{name:'date',label:'Sale date',type:'date',required:true}} value={values.date} onChange={value=>change('date',value)}/></div>
      <div className="record-section-heading"><h3>Sale items</h3><button className="secondary" type="button" onClick={()=>setLines([...lines,blankLine()])}><Plus size={14}/>Add item</button></div>
      <p className="record-help">Amounts are in {record?.currency||'CAD'}. Line sales is the total for that item’s quantity, before its discount.</p>
      {lines.map((line,index)=><div className="sale-line-card" key={index}><div className="sale-line-heading"><strong>Item {index+1}</strong><button className="icon danger" type="button" aria-label={`Remove item ${index+1}`} disabled={lines.length===1} onClick={()=>setLines(lines.filter((_,i)=>i!==index))}><Trash2 size={15}/></button></div>
        <div className="formgrid sale-line-grid">{[
          {name:'title',label:'Item title',required:true},{name:'variantTitle',label:'Variant / option'},{name:'sku',label:'SKU'},
          {name:'quantity',label:'Quantity',type:'number',min:1,step:'1',required:true},{name:'gross',label:'Line sales',type:'number',min:0,required:true},
          {name:'discount',label:'Line discount',type:'number',min:0},{name:'unitCost',label:'Unit cost',type:'number',min:0,step:'0.0001'}
        ].map(field=><InputField key={field.name} field={field} value={line[field.name]} onChange={value=>lineChange(index,field.name,value)}/>)}</div>
      </div>)}
      <div className="record-section-heading"><h3>Shipping, taxes & sale costs</h3></div>
      <div className="formgrid">{[
        ['shippingRevenue','Shipping charged'],['taxes','Sales tax collected'],['shippingCost','Shipping cost'],['paymentFees','Payment fees'],['materialCost','Packing materials'],['otherVariableCost','Other sale costs']
      ].map(([name,label])=><InputField key={name} field={{name,label,type:'number'}} value={values[name]} onChange={value=>change(name,value)}/>)}<InputField field={{name:'notes',label:'Notes',type:'textarea',wide:true}} value={values.notes} onChange={value=>change('notes',value)}/></div>
    </fieldset>
    <div className="sale-summary"><div><span>Product sales after discounts</span><strong>{money(net)}</strong></div><div><span>Total item costs</span><strong>{money(cogs)}</strong></div><div><span>Contribution profit</span><strong className={grossProfit<0?'negative':'positive'}>{money(grossProfit)}</strong></div></div>
    <SaveActions busy={busy} disabled={!access?.ownerAuthenticated} onClose={onClose} label={record?'Save sale changes':'Add manual sale'}/>
  </RecordDialog>;
}
