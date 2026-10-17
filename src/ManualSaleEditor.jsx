import React,{useEffect,useMemo,useState} from 'react';
import {Plus,Trash2} from 'lucide-react';
import {api,money} from './api.js';
import {InputField,RecordDialog,SaveActions,SignInNotice} from './LedgerRecords.jsx';

const blankLine=()=>({productId:'',variantId:'',title:'',variantTitle:'',sku:'',quantity:1,gross:0,discount:0,unitCost:0,unitPrice:0,autoPrice:true});
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
export default function ManualSaleEditor({record,onClose,onSaved}){
  const [access,setAccess]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [values,setValues]=useState(()=>({name:record?.name||'Manual sale',date:record?.createdAtShopify?.slice(0,10)||new Date().toISOString().slice(0,10),
    shippingRevenue:record?.shippingRevenue??0,shippingCost:record?.shippingCost??0,paymentFees:record?.paymentFees??0,materialCost:record?.materialCost??0,otherVariableCost:record?.otherVariableCost??0,notes:record?.notes||''}));
  const [lines,setLines]=useState(()=>record?.lines?.map(line=>({...line,unitPrice:Number(line.quantity)?Number(line.gross||0)/Number(line.quantity):0,autoPrice:false}))||[blankLine()]);
  const [afterTaxOverride,setAfterTaxOverride]=useState('');
  const [afterTaxTouched,setAfterTaxTouched]=useState(false);
  useEffect(()=>{api('/api/status').then(setAccess).catch(error=>setError(error.message));},[]);
  const change=(key,value)=>setValues({...values,[key]:value});
  const lineChange=(index,key,value)=>setLines(previous=>previous.map((line,i)=>{
    if(i!==index)return line;
    const next={...line,[key]:value};
    if(key==='gross')next.autoPrice=false;
    if(key==='quantity'&&line.autoPrice)next.gross=(Number(value)||0)*(Number(line.unitPrice)||0);
    return next;
  }));
  const pickVariant=(index,item)=>setLines(previous=>previous.map((line,i)=>i===index?{...line,productId:item.productId,variantId:item.variantId,title:item.title,variantTitle:item.variantTitle,sku:item.sku||'',unitCost:item.unitCost??0,unitPrice:item.price??0,gross:(item.price??0)*(Number(line.quantity)||1),autoPrice:true}:line));
  const net=useMemo(()=>lines.reduce((sum,line)=>sum+(Number(line.gross)||0)-(Number(line.discount)||0),0),[lines]);
  const taxableBase=net+(Number(values.shippingRevenue)||0);
  const defaultAfterTax=Math.round((taxableBase*1.13+Number.EPSILON)*100)/100;
  const existingAfterTax=record?.totalCollected!=null?Number(record.totalCollected):defaultAfterTax;
  const existingBase=(Number(record?.netSales)||0)+(Number(record?.shippingRevenue)||0);
  const existingDefault=Math.round((existingBase*1.13+Number.EPSILON)*100)/100;
  const hadCustomTax=!!record&&Math.abs(existingAfterTax-existingDefault)>0.01;
  const afterTax=afterTaxTouched?Number(afterTaxOverride||0):(hadCustomTax?existingAfterTax:defaultAfterTax);
  const taxes=Math.max(0,Math.round(((afterTax-taxableBase)+Number.EPSILON)*100)/100);
  const cogs=lines.reduce((sum,line)=>sum+(Number(line.unitCost)||0)*(Number(line.quantity)||0),0);
  const variable=['shippingCost','paymentFees','materialCost','otherVariableCost'].reduce((sum,key)=>sum+(Number(values[key])||0),0);
  const grossProfit=net+(Number(values.shippingRevenue)||0)-cogs-variable;
  const save=async event=>{
    event.preventDefault();setBusy(true);setError('');
    try{
      if(!record&&lines.some(line=>!line.variantId))throw new Error('Choose the Shopify item and variant for every sale line.');
      if(afterTax<taxableBase)throw new Error('After-tax total cannot be lower than the product sales plus shipping charged.');
      const body={...values,taxes,lines:lines.map(({unitPrice,autoPrice,...line})=>({...line,quantity:Number(line.quantity),gross:Number(line.gross),discount:Number(line.discount||0),unitCost:Number(line.unitCost||0)}))};
      if(record)body.expectedUpdatedAt=record.updatedAt;
      const result=await api(`/api/manual-sales${record?`/${record._id}`:''}`,{method:record?'PATCH':'POST',body:JSON.stringify(body)});onSaved(result);
    }catch(error){setError(error.message);}finally{setBusy(false);}
  };
  const afterTaxFieldValue=afterTaxTouched?afterTaxOverride:(hadCustomTax?existingAfterTax:defaultAfterTax);
  return <RecordDialog title={record?'Edit manual sale':'Add manual sale'} onClose={onClose} busy={busy} onSubmit={save} wide>
    <SignInNotice access={access}/>{error&&<div className="notice" role="alert">{error}</div>}
    <fieldset className="record-fieldset" disabled={busy||!access?.ownerAuthenticated}>
      <div className="formgrid"><InputField field={{name:'name',label:'Sale name',required:true}} value={values.name} onChange={value=>change('name',value)}/><InputField field={{name:'date',label:'Sale date',type:'date',required:true}} value={values.date} onChange={value=>change('date',value)}/></div>
      <div className="record-section-heading"><h3>Sale items</h3><button className="secondary" type="button" onClick={()=>setLines([...lines,blankLine()])}><Plus size={14}/>Add item</button></div>
      <p className="record-help">Choose the exact Shopify product variant sold. Its current Shopify cost is copied into the sale and the sold quantity is removed from Shopify inventory when you save.</p>
      {lines.map((line,index)=><div className="sale-line-card" key={line.variantId||index}><div className="sale-line-heading"><strong>Item {index+1}</strong><button className="icon danger" type="button" aria-label={`Remove item ${index+1}`} disabled={lines.length===1} onClick={()=>setLines(lines.filter((_,i)=>i!==index))}><Trash2 size={15}/></button></div>
        <CatalogPicker line={line} onPick={item=>pickVariant(index,item)}/>
        {line.variantId&&<div className="record-help"><strong>{displayName(line)}</strong> · Cost {money(line.unitCost||0)}</div>}
        {!line.variantId&&record&&<div className="record-help">Legacy manual item: {line.title||'No linked Shopify variant'}. Choose a Shopify item above if you want future quantity changes to update inventory.</div>}
        <div className="formgrid sale-line-grid">{[
          {name:'quantity',label:'Quantity',type:'number',min:1,step:'1',required:true},{name:'gross',label:'Sale amount before tax',type:'number',min:0,required:true},
          {name:'discount',label:'Line discount',type:'number',min:0}
        ].map(field=><InputField key={field.name} field={field} value={line[field.name]} onChange={value=>lineChange(index,field.name,value)}/>)}</div>
      </div>)}
      <div className="record-section-heading"><h3>Shipping, tax & sale costs</h3></div>
      <div className="formgrid"><InputField field={{name:'shippingRevenue',label:'Shipping charged',type:'number'}} value={values.shippingRevenue} onChange={value=>change('shippingRevenue',value)}/><InputField field={{name:'afterTax',label:'After-tax total',type:'number',min:0,step:'0.01'}} value={afterTaxFieldValue} onChange={value=>{setAfterTaxTouched(true);setAfterTaxOverride(value);}}/></div>
      <p className="record-help">After-tax total follows the sale amount at Ontario’s 13% HST unless you manually overwrite it. Current tax portion: {money(taxes)}.</p>
      <div className="formgrid">{[
        ['shippingCost','Shipping cost'],['paymentFees','Payment fees'],['materialCost','Packing materials'],['otherVariableCost','Other sale costs']
      ].map(([name,label])=><InputField key={name} field={{name,label,type:'number'}} value={values[name]} onChange={value=>change(name,value)}/>)}<InputField field={{name:'notes',label:'Notes',type:'textarea',wide:true}} value={values.notes} onChange={value=>change('notes',value)}/></div>
    </fieldset>
    <div className="sale-summary"><div><span>Product sales after discounts</span><strong>{money(net)}</strong></div><div><span>Tax collected</span><strong>{money(taxes)}</strong></div><div><span>After-tax collected</span><strong>{money(afterTax)}</strong></div><div><span>Total item costs</span><strong>{money(cogs)}</strong></div><div><span>Contribution profit</span><strong className={grossProfit<0?'negative':'positive'}>{money(grossProfit)}</strong></div></div>
    <SaveActions busy={busy} disabled={!access?.ownerAuthenticated} onClose={onClose} label={record?'Save sale changes':'Add manual sale'}/>
  </RecordDialog>;
}
