import React,{useEffect,useMemo,useState} from 'react';
import {Plus,Trash2} from 'lucide-react';
import {api,money} from './api.js';
import {InputField,RecordDialog,SaveActions,SignInNotice} from './LedgerRecords.jsx';

const blankLine=()=>({clientKey:crypto.randomUUID(),productId:'',variantId:'',title:'',variantTitle:'',sku:'',quantity:1,gross:0,discount:0,unitCost:0,unitPrice:0,unitDiscount:0,autoPrice:true});
const displayName=item=>`${item.title}${item.variantTitle&&item.variantTitle!=='Default Title'?` — ${item.variantTitle}`:''}${item.sku?` (${item.sku})`:''}`;
function CatalogPicker({line,onPick}){
  const [query,setQuery]=useState(line.variantId?displayName(line):''),[items,setItems]=useState([]),[loading,setLoading]=useState(false),[error,setError]=useState('');
  useEffect(()=>{
    let active=true;const timer=setTimeout(async()=>{
      setLoading(true);setError('');
      try{const result=await api(`/api/inventory?q=${encodeURIComponent(query)}&page=1`);if(active)setItems(result.items||[]);}
      catch(error){if(active)setError(error.message);}finally{if(active)setLoading(false);}
    },180);
    return()=>{active=false;clearTimeout(timer);};
  },[query]);
  const pick=id=>{
    const item=items.find(value=>value._id===id);if(!item)return;
    setQuery(displayName(item));onPick(item);
  };
  return <div className="catalog-picker">
    <label className="field"><span>Shopify item / variant</span><input value={query} onChange={event=>setQuery(event.target.value)} placeholder="Search product, variant or SKU"/></label>
    <label className="field"><span>Choose result</span><select value="" onChange={event=>pick(event.target.value)} disabled={loading}><option value="">{loading?'Searching…':items.length?'Select an item…':'No matching items'}</option>{items.map(item=><option key={item._id} value={item._id}>{displayName(item)} · {item.quantity==null?'Untracked':`${item.quantity} in stock`} · {money(item.price)}</option>)}</select></label>
    {error&&<small className="negative">{error}</small>}
  </div>;
}
export default function ManualSaleEditor({record,onClose,onSaved,addItem=false}){
  const [access,setAccess]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [values,setValues]=useState(()=>({paymentStatus:record?.paymentStatus||'',name:record?.name||'Manual sale',date:record?.createdAtShopify?.slice(0,10)||new Date().toISOString().slice(0,10),
    shippingRevenue:record?.shippingRevenue??0,shippingCost:record?.shippingCost??0,paymentFees:record?.paymentFees??0,materialCost:record?.materialCost??0,otherVariableCost:record?.otherVariableCost??0,notes:record?.notes||''}));
  const [lines,setLines]=useState(()=>{
    const existing=record?.lines?.map((line,originalIndex)=>({...line,originalIndex,clientKey:crypto.randomUUID(),unitPrice:Number(line.quantity)?Number(line.gross||0)/Number(line.quantity):0,unitDiscount:Number(line.quantity)?Number(line.discount||0)/Number(line.quantity):0,autoPrice:true}))||[];
    return existing.length?(addItem?[...existing,blankLine()]:existing):[blankLine()];
  });
  const [restockChoices,setRestockChoices]=useState({});
  const reductions=(record?.lines||[]).map((line,index)=>{
    const retained=lines.find(item=>item.originalIndex===index);
    return {...line,index,removed:line.quantity-(Number(retained?.quantity)||0)};
  }).filter(line=>line.removed>0);
  const [afterTaxOverride,setAfterTaxOverride]=useState('');
  const [afterTaxTouched,setAfterTaxTouched]=useState(false);
  useEffect(()=>{api('/api/status').then(setAccess).catch(error=>setError(error.message));},[]);
  const change=(key,value)=>setValues({...values,[key]:value});
  const lineChange=(index,key,value)=>setLines(previous=>previous.map((line,i)=>{
    if(i!==index)return line;
    const next={...line,[key]:value};
    if(key==='gross')next.autoPrice=false;
    if(key==='discount')next.unitDiscount=(Number(value)||0)/(Number(line.quantity)||1);
    if(key==='quantity'&&line.autoPrice){next.gross=Math.round(((Number(value)||0)*(Number(line.unitPrice)||0)+Number.EPSILON)*100)/100;next.discount=Math.round(((Number(value)||0)*(Number(line.unitDiscount)||0)+Number.EPSILON)*100)/100;}
    return next;
  }));
  const pickVariant=(index,item)=>setLines(previous=>previous.map((line,i)=>i===index?{...line,productId:item.productId,variantId:item.variantId,title:item.title,variantTitle:item.variantTitle,sku:item.sku||'',unitCost:item.unitCost??0,unitPrice:item.price??0,gross:(item.price??0)*(Number(line.quantity)||1),autoPrice:true}:line));
  const net=useMemo(()=>lines.reduce((sum,line)=>sum+(Number(line.gross)||0)-(Number(line.discount)||0),0),[lines]);
  const taxableBase=net+(Number(values.shippingRevenue)||0);
  const defaultAfterTax=Math.round((taxableBase*1.13+Number.EPSILON)*100)/100;
  const afterTax=afterTaxTouched?Number(afterTaxOverride||0):defaultAfterTax;
  const taxes=Math.max(0,Math.round(((afterTax-taxableBase)+Number.EPSILON)*100)/100);
  const cogs=lines.reduce((sum,line)=>sum+(Number(line.unitCost)||0)*(Number(line.quantity)||0),0);
  const variable=['shippingCost','paymentFees','materialCost','otherVariableCost'].reduce((sum,key)=>sum+(Number(values[key])||0),0);
  const grossProfit=net+(Number(values.shippingRevenue)||0)-cogs-variable;
  const save=async event=>{
    event.preventDefault();setBusy(true);setError('');
    try{
      if(lines.some(line=>line.originalIndex==null&&!line.variantId))throw new Error('Choose the Shopify item and variant for every sale line.');
      if(reductions.some(line=>line.variantId&&typeof restockChoices[line.index]!=='boolean'))throw new Error('Choose whether each removed item should return to inventory.');
      if(afterTax<taxableBase)throw new Error('After-tax total cannot be lower than the product sales plus shipping charged.');
      const body={...values,paymentStatus:values.paymentStatus||null,taxes,restockChoices:reductions.filter(line=>line.variantId).map(line=>({index:line.index,restock:restockChoices[line.index]})),lines:lines.map(({unitPrice,unitDiscount,autoPrice,clientKey,...line})=>({...line,quantity:Number(line.quantity),gross:Number(line.gross),discount:Number(line.discount||0),unitCost:Number(line.unitCost||0)}))};
      if(record)body.expectedUpdatedAt=record.updatedAt;
      const result=await api(`/api/manual-sales${record?`/${record._id}`:''}`,{method:record?'PATCH':'POST',body:JSON.stringify(body)});onSaved(result);
    }catch(error){setError(error.message);}finally{setBusy(false);}
  };
  const afterTaxFieldValue=afterTaxTouched?afterTaxOverride:defaultAfterTax;
  return <RecordDialog title={record?'Edit manual sale':'Add manual sale'} onClose={onClose} busy={busy} onSubmit={save} wide>
    <SignInNotice access={access}/>{error&&<div className="notice" role="alert">{error}</div>}
    <fieldset className="record-fieldset" disabled={busy||!access?.ownerAuthenticated}>
      <div className="formgrid"><InputField field={{name:'name',label:'Sale name',required:true}} value={values.name} onChange={value=>change('name',value)}/><InputField field={{name:'date',label:'Sale date',type:'date',required:true}} value={values.date} onChange={value=>change('date',value)}/></div>
      <label className="field"><span>Payment status</span><select value={values.paymentStatus} onChange={event=>change('paymentStatus',event.target.value)}><option value="">Not set</option><option value="paid">Paid</option><option value="unpaid">Unpaid</option></select></label>
      <div className="record-section-heading"><h3>Sale items</h3><button className="secondary" type="button" onClick={()=>setLines([...lines,blankLine()])}><Plus size={14}/>Add item</button></div>
      <p className="record-help">Choose the exact Shopify product variant sold. New items use their current Shopify cost and are removed from inventory when you save. Existing items retain their saved costs.</p>
      {lines.map((line,index)=><div className="sale-line-card" key={line.clientKey}><div className="sale-line-heading"><strong>Item {index+1}</strong><button className="icon danger" type="button" aria-label={`Remove item ${index+1}`} disabled={lines.length===1} title={lines.length===1?'Use Cancel / remove sale to remove the last item':'Remove this item; choose inventory return below'} onClick={()=>setLines(lines.filter((_,i)=>i!==index))}><Trash2 size={15}/></button></div>
        {line.originalIndex==null?<CatalogPicker line={line} onPick={item=>pickVariant(index,item)}/>:<p className="record-help">To replace this item, remove it and use Add item.</p>}
        {line.variantId&&<div className="record-help"><strong>{displayName(line)}</strong> · Cost {money(line.unitCost||0)}</div>}
        {!line.variantId&&line.originalIndex!=null&&<div className="record-help">Legacy manual item: {line.title||'No linked Shopify variant'}. This item is not linked to inventory.</div>}
        <div className="formgrid sale-line-grid">{[
          {name:'quantity',label:'Quantity',type:'number',min:1,step:'1',required:true},{name:'gross',label:'Sale amount before tax',type:'number',min:0,required:true},
          {name:'discount',label:'Line discount',type:'number',min:0}
        ].map(field=><InputField key={field.name} field={field} value={line[field.name]} onChange={value=>lineChange(index,field.name,value)}/>)}</div>
      </div>)}
      {reductions.length>0&&<section className="inventory-return-review"><h3>Removed items — inventory return</h3><p className="record-help">Choose whether each removed quantity should go back into inventory when you save.</p><div className="actions"><button type="button" className="secondary" onClick={()=>setRestockChoices(Object.fromEntries(reductions.map(line=>[line.index,true])))}>Return all</button><button type="button" className="secondary" onClick={()=>setRestockChoices(Object.fromEntries(reductions.map(line=>[line.index,false])))}>Return none</button></div>
        {reductions.map(line=><div className="sale-line-card" key={line.index}><strong>{displayName(line)} · {line.removed} removed</strong>{line.variantId?<label className="field"><span>Return removed quantity to inventory?</span><select required value={restockChoices[line.index]===undefined?'':String(restockChoices[line.index])} onChange={event=>setRestockChoices({...restockChoices,[line.index]:event.target.value==='true'})}><option value="" disabled>Choose…</option><option value="true">Yes — return {line.removed} to inventory</option><option value="false">No — leave inventory unchanged</option></select></label>:<p className="record-help">No linked Shopify variant; inventory cannot be returned automatically.</p>}</div>)}
      </section>}
      <div className="record-section-heading"><h3>Shipping, tax & sale costs</h3></div>
      <div className="formgrid"><InputField field={{name:'shippingRevenue',label:'Shipping charged',type:'number'}} value={values.shippingRevenue} onChange={value=>change('shippingRevenue',value)}/><InputField field={{name:'afterTax',label:'After-tax total',type:'number',min:0,step:'0.01'}} value={afterTaxFieldValue} onChange={value=>{setAfterTaxTouched(true);setAfterTaxOverride(value);}}/></div>
      <p className="record-help">After-tax total automatically follows the current sale amount at Ontario’s 13% HST. It only stops recalculating if you manually type over this field during the current edit.</p>
      <div className="formgrid">{[
        ['shippingCost','Shipping cost'],['paymentFees','Payment fees'],['materialCost','Packing materials'],['otherVariableCost','Other sale costs']
      ].map(([name,label])=><InputField key={name} field={{name,label,type:'number'}} value={values[name]} onChange={value=>change(name,value)}/>)}<InputField field={{name:'notes',label:'Notes',type:'textarea',wide:true}} value={values.notes} onChange={value=>change('notes',value)}/></div>
    </fieldset>
    <div className="sale-summary"><div><span>Product sales after discounts</span><strong>{money(net)}</strong></div><div><span>Tax collected</span><strong>{money(taxes)}</strong></div><div><span>After-tax collected</span><strong>{money(afterTax)}</strong></div><div><span>Total item costs</span><strong>{money(cogs)}</strong></div><div><span>Contribution profit</span><strong className={grossProfit<0?'negative':'positive'}>{money(grossProfit)}</strong></div></div>
    <SaveActions busy={busy} disabled={!access?.ownerAuthenticated} onClose={onClose} label={record?'Save sale changes':'Add manual sale'}/>
  </RecordDialog>;
}

