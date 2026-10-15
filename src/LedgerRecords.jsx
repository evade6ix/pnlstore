import React,{useEffect,useRef,useState} from 'react';
import {Plus,Pencil,Trash2,Search,RefreshCw,X} from 'lucide-react';
import {api,money,dateFmt} from './api.js';

const today=()=>new Date().toISOString().slice(0,10);
const definitions={
  expenses:{title:'Operating expenses',singular:'expense',subtitle:'Manage operating costs, receipts, categories and recurring expense labels.',columns:[['date','Date','date'],['vendor','Vendor'],['category','Category'],['amount','Amount','money'],['tax','Tax','money']],fields:[
    {name:'date',label:'Date',type:'date',required:true},{name:'vendor',label:'Vendor',required:true},{name:'category',label:'Category',required:true},
    {name:'amount',label:'Expense amount',type:'number',required:true},{name:'tax',label:'Tax (tracked separately)',type:'number'},
    {name:'description',label:'Description'},{name:'reference',label:'Invoice / receipt reference'},
    {name:'recurring',label:'Mark as recurring',type:'checkbox'},{name:'notes',label:'Notes',type:'textarea',wide:true}]},
  purchases:{title:'Purchases & POs',singular:'purchase / PO',subtitle:'Manage supplier purchases, status, freight, duties and taxes.',columns:[['date','Date','date'],['vendor','Vendor'],['poNumber','PO number'],['status','Status'],['outlay','Total outlay','money']],fields:[
    {name:'date',label:'Date',type:'date',required:true},{name:'vendor',label:'Vendor',required:true},{name:'poNumber',label:'PO / invoice number'},
    {name:'status',label:'Status',type:'select',options:['draft','ordered','unpaid','paid','received','cancelled']},
    {name:'total',label:'Inventory / goods amount',type:'number',required:true},{name:'shipping',label:'Inbound shipping',type:'number'},
    {name:'duties',label:'Duties / import fees',type:'number'},{name:'tax',label:'Tax',type:'number'},{name:'notes',label:'Notes',type:'textarea',wide:true}]},
  costs:{title:'Product cost overrides',singular:'cost override',subtitle:'Manage effective-dated costs for new order imports. Saved order costs stay attached to each sale.',columns:[['sku','SKU'],['title','Product / variant'],['unitCost','Unit cost','money'],['effectiveFrom','Effective from','date'],['notes','Notes']],fields:[
    {name:'sku',label:'SKU'},{name:'variantId',label:'Shopify variant ID (if no SKU)'},{name:'title',label:'Product / variant'},
    {name:'unitCost',label:'Unit cost',type:'number',min:0,step:'0.0001',required:true},{name:'effectiveFrom',label:'Effective from',type:'date',required:true},
    {name:'notes',label:'Notes',type:'textarea',wide:true}]}
};
export function InputField({field,value,onChange}){
  const {name,label,type='text',required,min,step='0.01',wide,options=[]}=field;
  if(type==='checkbox')return <label className="record-check"><input name={name} type="checkbox" checked={!!value} onChange={event=>onChange(event.target.checked)}/><span>{label}</span></label>;
  return <label className={wide?'wide':''}><span>{label}</span>{type==='textarea'?<textarea name={name} value={value??''} maxLength={10000} onChange={event=>onChange(event.target.value)}/>:
    type==='select'?<select name={name} value={value??''} onChange={event=>onChange(event.target.value)}>{[...new Set([...options,...(value&&!options.includes(value)?[value]:[])])].map(option=><option key={option} value={option}>{option}</option>)}</select>:
    <input name={name} type={type} required={required} min={min} step={type==='number'?step:undefined} value={value??''} onChange={event=>onChange(event.target.value)}/>}</label>;
}
export function RecordDialog({title,onClose,busy,children,onSubmit,wide=false}){
  const ref=useRef(null);useEffect(()=>{ref.current.showModal();},[]);
  return <dialog ref={ref} className={wide?'record-dialog record-dialog-wide':'record-dialog'} onCancel={event=>{event.preventDefault();if(!busy)onClose();}}><form onSubmit={onSubmit}>
    <div className="modal-head"><h2>{title}</h2><button type="button" className="icon" aria-label="Close editor" disabled={busy} onClick={onClose}><X size={18}/></button></div>{children}
  </form></dialog>;
}
export function SignInNotice({access}){return access&&!access.ownerAuthenticated?<div className="notice"><div><strong>Sign in to manage this workspace</strong><span>Your Shopify sign-in enables saving financial records.</span></div><a className="button" href={access.authUrl}>Sign in with Shopify</a></div>:null;}
export function SaveActions({busy,disabled,onClose,label='Save changes'}){return <div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" disabled={busy||disabled}>{busy?<><RefreshCw size={15} className="spin"/>Saving…</>:label}</button></div>;}
function RecordEditor({kind,record,access,onClose,onSaved}){
  const config=definitions[kind];
  const [values,setValues]=useState(()=>Object.fromEntries(config.fields.map(field=>[field.name,record?.[field.name]??(field.type==='date'?today():field.type==='number'?0:field.type==='checkbox'?false:field.name==='status'?'paid':'')]).map(([key,value])=>[key,config.fields.find(field=>field.name===key)?.type==='date'?String(value).slice(0,10):value])));
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const save=async event=>{
    event.preventDefault();setBusy(true);setError('');
    try{
      const body=Object.fromEntries(config.fields.map(field=>[field.name,field.type==='number'?Number(values[field.name]||0):values[field.name]]));
      if(record)body.expectedUpdatedAt=record.updatedAt;
      const saved=await api(`/api/${kind}${record?`/${record._id}`:''}`,{method:record?'PATCH':'POST',body:JSON.stringify(body)});
      onSaved(saved);
    }catch(error){setError(error.message);}finally{setBusy(false);}
  };
  const outlay=['total','shipping','duties','tax'].reduce((sum,key)=>sum+(Number(values[key])||0),0);
  return <RecordDialog title={`${record?'Edit':'Add'} ${config.singular}`} busy={busy} onClose={onClose} onSubmit={save}>
    <SignInNotice access={access}/>{error&&<div className="notice" role="alert">{error}</div>}
    <fieldset className="record-fieldset" disabled={busy||!access?.ownerAuthenticated}><div className="formgrid">{config.fields.map(field=><InputField key={field.name} field={field} value={values[field.name]} onChange={value=>setValues({...values,[field.name]:value})}/>)}</div></fieldset>
    {kind==='purchases'&&<div className="record-summary"><span>Goods + shipping + duties + tax</span><strong>{money(outlay)}</strong></div>}
    {kind==='expenses'&&<p className="record-help">The P&L uses the expense amount. Tax is tracked separately. Negative amounts can record expense credits.</p>}
    {kind==='costs'&&<p className="record-help">Enter a SKU or Shopify variant ID. To correct the cost of an existing sale, edit its order costs.</p>}
    <SaveActions busy={busy} disabled={!access?.ownerAuthenticated} onClose={onClose} label={record?'Save changes':'Add record'}/>
  </RecordDialog>;
}
function RecordsPage({kind}){
  const config=definitions[kind], [items,setItems]=useState([]),[access,setAccess]=useState(null),[query,setQuery]=useState('');
  const [editor,setEditor]=useState(undefined),[loading,setLoading]=useState(true),[error,setError]=useState(''),[message,setMessage]=useState(''),[deleting,setDeleting]=useState(null);
  const load=async()=>{setError('');setLoading(true);try{const [records,status]=await Promise.all([api(`/api/${kind}`),api('/api/status')]);setItems(records);setAccess(status);}catch(error){setError(error.message);}finally{setLoading(false);}};
  useEffect(()=>{load();},[kind]);
  const save=record=>{setItems(previous=>[record,...previous.filter(item=>item._id!==record._id)].sort((a,b)=>String(b[kind==='costs'?'effectiveFrom':'date']).localeCompare(String(a[kind==='costs'?'effectiveFrom':'date']))));setEditor(undefined);setMessage('Changes saved. Reports will use the updated record.');};
  const remove=async item=>{if(!window.confirm(`Delete this ${config.singular}? This removes it from your ledger and reports.`))return;setDeleting(item._id);setError('');try{await api(`/api/${kind}/${item._id}`,{method:'DELETE',body:JSON.stringify({expectedUpdatedAt:item.updatedAt})});setItems(previous=>previous.filter(row=>row._id!==item._id));setMessage('Record deleted.');}catch(error){setError(error.message);}finally{setDeleting(null);}};
  const q=query.trim().toLowerCase(),filtered=items.filter(item=>!q||config.fields.some(field=>String(item[field.name]??'').toLowerCase().includes(q)));
  return <>
    <header><div><h1>{config.title}</h1><p>{config.subtitle}</p></div><button onClick={()=>{setMessage('');setEditor(null);}}><Plus size={16}/>Add {config.singular}</button></header>
    <SignInNotice access={access}/>{error&&<div className="notice" role="alert"><div>{error}</div><button className="secondary" onClick={load}>Reload</button></div>}{message&&<div className="inventory-note inventory-saved" role="status">{message}</div>}
    <div className="toolbar"><div className="search"><Search size={17}/><input aria-label={`Search ${config.title.toLowerCase()}`} placeholder="Search records…" value={query} onChange={event=>setQuery(event.target.value)}/></div><span className="count">{filtered.length} records</span></div>
    <section className="panel flush"><div className="tablewrap"><table><thead><tr>{config.columns.map(([key,label,type])=><th key={key} className={type==='money'?'num':''}>{label}</th>)}<th className="num">Actions</th></tr></thead><tbody>
      {filtered.map(item=><tr key={item._id} className="record-row">{config.columns.map(([key,label,type])=>{const value=key==='outlay'?['total','shipping','duties','tax'].reduce((sum,name)=>sum+(item[name]||0),0):item[key];return <td key={key} className={type==='money'?'num':''}>{type==='money'?money(value):type==='date'?dateFmt(value?String(value).slice(0,10):value):value||'—'}{key==='vendor'&&item.description&&<div className="small">{item.description}</div>}{key==='category'&&item.recurring&&<div className="small">Recurring</div>}</td>;})}<td className="num"><div className="record-row-actions"><button className="secondary" onClick={()=>{setMessage('');setEditor(item);}} aria-label={`Edit ${item.vendor||item.title||item.sku||config.singular}`}><Pencil size={13}/>Edit</button><button className="icon danger" disabled={!!deleting||!access?.ownerAuthenticated} onClick={()=>remove(item)} aria-label={`Delete ${item.vendor||item.title||item.sku||config.singular}`}><Trash2 size={15}/></button></div></td></tr>)}
      {!filtered.length&&<tr><td colSpan={config.columns.length+1} className="empty">{loading?'Loading records…':query?'No records match your search.':'No records yet. Add your first record above.'}</td></tr>}
    </tbody></table></div></section>
    {editor!==undefined&&<RecordEditor kind={kind} record={editor} access={access} onClose={()=>setEditor(undefined)} onSaved={save}/>}
  </>;
}
export const Costs=()=> <RecordsPage kind="costs"/>;
export const Expenses=()=> <RecordsPage kind="expenses"/>;
export const Purchases=()=> <RecordsPage kind="purchases"/>;
