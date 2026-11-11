import React,{useEffect,useState} from 'react';
import {NavLink} from 'react-router-dom';
import {RefreshCw,Search,ChevronLeft,ChevronRight,X,Save,ExternalLink,ReceiptText,CheckCircle2,AlertCircle,Clock3} from 'lucide-react';
import {api,money,dateFmt,pct} from './api.js';

const inputs=[
  ['paymentFees','Shopify processing + FX fees'],
  ['shippingCost','Actual shipping cost'],
  ['materialCost','Packaging and materials'],
  ['cashbackCost','Store credit issued (expense)'],
  ['otherVariableCost','Other variable costs']
];
function financials(order){
  const n=key=>Number(order[key]||0);
  const round=n=>Math.round((n+Number.EPSILON)*100)/100;
  const revenue=round(n('netSales')+n('shippingRevenue'));
  const variable=inputs.reduce((sum,[key])=>sum+n(key),0);
  const takeHome=round(revenue-variable),profit=round(takeHome-n('cogs'));
  return {revenue,takeHome,profit,margin:revenue?profit/revenue*100:0};
}
const StateLabel=({state})=><span className={'platform-state '+(state==='running'?'active':state==='error'?'error':'')}>{state==='running'?<RefreshCw size={13} className="spin"/>:state==='idle'?<CheckCircle2 size={13}/>:<Clock3 size={13}/>} {state==='running'?'Importing orders':state==='idle'?'Up to date':state==='error'?'Sync failed':state==='interrupted'?'Sync interrupted':'Not imported'}</span>;

export default function ShopifyPlatformOrders(){
  const [query,setQuery]=useState(''),[page,setPage]=useState(1);
  const [result,setResult]=useState({items:[],total:0,limit:40,summary:{}});
  const [status,setStatus]=useState(null),[selected,setSelected]=useState(null);
  const [values,setValues]=useState({}),[loading,setLoading]=useState(true);
  const [error,setError]=useState(''),[formError,setFormError]=useState(''),[saving,setSaving]=useState(false),[syncBusy,setSyncBusy]=useState(false);
  const load=async()=>{try{const r=await api('/api/shopify-platform-orders?q='+encodeURIComponent(query)+'&page='+page);setResult(r);setError('');}catch(e){setError(e.message);}finally{setLoading(false);}};
  const loadStatus=async()=>{try{const s=await api('/api/shopify-platform-orders/status');setStatus(s);}catch(e){setError(e.message);}};
  useEffect(()=>{setLoading(true);const timer=setTimeout(load,180);return()=>clearTimeout(timer);},[query,page]);
  useEffect(()=>{loadStatus();const timer=setInterval(()=>{loadStatus();load();},15000);return()=>clearInterval(timer);},[query,page]);
  const sync=async()=>{setSyncBusy(true);setError('');try{await api('/api/shopify-platform-orders/sync',{method:'POST',body:'{}'});await loadStatus();}catch(e){setError(e.message);}finally{setSyncBusy(false);}};
  const open=order=>{setFormError('');setSelected(order);setValues(Object.fromEntries([...inputs.map(([key])=>[key,String(order[key]??0)]),['notes',order.notes||'']]));};
  const close=()=>{if(!saving)setSelected(null);};
  const save=async e=>{e.preventDefault();setSaving(true);setFormError('');try{
    const body=Object.fromEntries(inputs.map(([key])=>[key,Number(values[key])]));
    body.notes=values.notes;body.expectedUpdatedAt=selected.updatedAt;
    const order=await api('/api/orders/'+selected._id,{method:'PATCH',body:JSON.stringify(body)});
    setSelected({...order,financials:financials(order)});
    await load();await loadStatus();setSelected(null);
  }catch(e){setFormError(e.message);}finally{setSaving(false);}};
  const summary=result.summary||{},pages=Math.max(1,Math.ceil(result.total/result.limit));
  const preview=selected?financials({...selected,...values}):null;
  const state=status?.state||{};
  return <>
    <header><div><div className="platform-heading"><h1>Shopify Platform Orders</h1><span className="platform-label">MongoDB ledger</span></div><p>Shopify orders saved permanently, with actual fulfilment costs and contribution profit per order.</p></div>
      <div className="actions"><StateLabel state={state.state}/><button className="secondary" onClick={sync} disabled={syncBusy||state.state==='running'||!status?.connected||!status?.ownerAuthenticated}><RefreshCw size={16} className={syncBusy||state.state==='running'?'spin':''}/>{syncBusy?'Starting…':state.state==='running'?'Syncing…':'Import / refresh Shopify'}</button></div>
    </header>
    {!status?.connected&&status&&<div className="notice"><AlertCircle size={18}/><div><strong>Shopify is not connected.</strong><span>Connect your store to start saving its orders.</span></div><a className="button" href={'/auth?shop='+(status?.shop||'')}>Connect store</a></div>}
    {status?.connected&&!status?.ownerAuthenticated&&<div className="notice"><AlertCircle size={18}/><div><strong>Sign in to edit or import.</strong><span>Browsing existing orders is available, but changes require your Shopify owner session.</span></div><a className="button" href={'/auth?shop='+status.shop}>Sign in</a></div>}
    {state.state==='error'&&<div className="notice" role="alert"><AlertCircle size={18}/><div><strong>Shopify order import failed.</strong><span>{state.error||'Try importing again.'}</span></div></div>}
    {error&&<div className="notice" role="alert"><AlertCircle size={18}/><div>{error}</div></div>}
    <div className="platform-kpis">
      <div className="platform-kpi"><span>Shopify revenue</span><strong>{money(summary.revenue||0)}</strong><small>After discounts and returns, before tax</small></div>
      <div className="platform-kpi"><span>Take-home before COGS</span><strong>{money(summary.takeHome||0)}</strong><small>After fees, fulfilment, packaging and cashback</small></div>
      <div className="platform-kpi"><span>Order contribution profit</span><strong className={(summary.profit||0)<0?'negative':'positive'}>{money(summary.profit||0)}</strong><small>After product COGS and variable costs</small></div>
      <div className="platform-kpi"><span>Orders needing review</span><strong>{summary.needsReview||0}</strong><small>Costs not yet confirmed</small></div>
    </div>
    <div className="platform-banner"><div><strong>{status?.orders||0} Shopify orders saved in MongoDB</strong><span> {state.state==='running'?' · '+(state.synced||0)+' imported in this run':state.lastCompletedAt?' · Last sync '+dateFmt(state.lastCompletedAt):' · Run your first import to populate the ledger'}</span></div><span>Existing manual cost edits are preserved on re-import.</span></div>
    <div className="toolbar"><div className="search"><Search size={17}/><input placeholder="Search order, discount code or SKU…" aria-label="Search Shopify orders" value={query} onChange={e=>{setQuery(e.target.value);setPage(1);}}/></div><span className="count">{result.total} matching orders</span></div>
    <section className="panel flush"><div className="tablewrap"><table className="platform-table"><thead><tr><th>Order</th><th>Date</th><th>Discount code</th><th className="num">Revenue</th><th className="num">Fees</th><th className="num">Shipping</th><th className="num">Store Credit Given</th><th className="num">Take-home</th><th className="num">Profit</th><th></th></tr></thead><tbody>
      {result.items.map(order=>{const f=order.financials||financials(order);return <tr key={order._id}><td><button className="platform-row-link" onClick={()=>open(order)}><strong>{order.name||order.orderNumber}</strong></button><div className="platform-row-meta">{order.costsReviewed?<span className="platform-reviewed">Costs reviewed</span>:<span className="platform-unreviewed">Needs cost review</span>}</div></td><td>{dateFmt(order.createdAtShopify)}</td><td><span className="platform-code">{(order.discountCodes||[]).join(', ')||'—'}</span>{order.discounts>0&&<div className="small">−{money(order.discounts)}</div>}</td><td className="num">{money(f.revenue)}</td><td className="num muted">{money(order.paymentFees||0)}<div className="small">{order.paymentFeeSource==='shopify'?'Shopify actual':order.paymentFeeSource==='manual'?'Manual override':'Not available'}</div></td><td className="num muted">{money(order.shippingCost||0)}</td><td className="num muted">{order.storeCreditGiven==null?'—':money(order.storeCreditGiven)}{order.storeCreditOriginal!=null&&order.storeCreditCurrency&&order.storeCreditCurrency!==order.currency&&<div className="small">{order.storeCreditCurrency} {Number(order.storeCreditOriginal).toFixed(2)}</div>}{order.cashbackSource==='manual'&&<div className="small">Manual cost {money(order.cashbackCost)}</div>}</td><td className="num strong">{money(f.takeHome)}</td><td className={'num strong '+(f.profit<0?'negative':'positive')}>{money(f.profit)}</td><td><button className="platform-edit" aria-label={'Edit costs for '+order.name} onClick={()=>open(order)}><ChevronRight size={16}/></button></td></tr>;})}
      {!result.items.length&&<tr><td className="empty" colSpan="10">{loading?'Loading Shopify orders…':'No Shopify orders have been imported for this search.'}</td></tr>}
    </tbody></table></div>
      <div className="inventory-pagination"><span>Page {page} of {pages}</span><div><button className="secondary" disabled={page<=1} onClick={()=>setPage(page-1)}><ChevronLeft size={15}/>Previous</button><button className="secondary" disabled={page>=pages} onClick={()=>setPage(page+1)}>Next<ChevronRight size={15}/></button></div></div>
    </section>
    <p className="platform-disclaimer">Take-home and profit are preliminary until all actual costs are entered. Taxes collected are excluded from revenue and profit. Shopify Payments processing and foreign-exchange fees are imported automatically when available, with manual override supported. Store credit is imported from the exact order metafield.</p>
    {selected&&<div className="platform-overlay" onMouseDown={e=>{if(e.target===e.currentTarget)close();}}><section className="platform-drawer" role="dialog" aria-modal="true" aria-label="Shopify order financial details">
      <div className="platform-drawer-head"><div><span className="platform-eyebrow">SHOPIFY ORDER</span><h2>{selected.name||selected.orderNumber}</h2><p>{dateFmt(selected.createdAtShopify)} · {selected.financialStatus||'Imported'}</p></div><button className="secondary" aria-label="Close order editor" onClick={close} disabled={saving}><X size={17}/></button></div>
      <div className="platform-scroll"><div className="platform-revenue-stack">
        <div><span>Product revenue after discounts / returns</span><strong>{money(selected.netSales)}</strong></div>
        <div><span>Shipping charged to customer</span><strong>{money(selected.shippingRevenue)}</strong></div>
        <div><span>Shopify discount amount</span><strong>−{money(selected.discounts)}</strong></div>
        <div><span>Refunded merchandise</span><strong>−{money(selected.returns)}</strong></div>
        <div><span>Discount codes</span><strong>{(selected.discountCodes||[]).join(', ')||'None'}</strong></div>
        <div><span>Store Credit Given (Shopify metafield)</span><strong>{selected.storeCreditGiven==null?'Not present':money(selected.storeCreditGiven)}{selected.storeCreditOriginal!=null&&selected.storeCreditCurrency&&selected.storeCreditCurrency!==selected.currency?' ('+selected.storeCreditCurrency+' '+Number(selected.storeCreditOriginal).toFixed(2)+')':''}</strong></div>
        <div className="platform-revenue-total"><span>Revenue (after discounts and refunds)</span><strong>{money(preview.revenue)}</strong></div>
      </div>
      <form id="platform-cost-form" onSubmit={save}><h3>Actual variable costs</h3>{formError&&<div className="notice" role="alert"><AlertCircle size={16}/><div>{formError}</div></div>}<p className="platform-hint">Shopify Payments fees and Store Credit Given are imported automatically into the CAD ledger. Changing either amount creates a manual override that future syncs preserve.</p>
        <div className="platform-auto-fees"><strong>Payment fee source: {selected.paymentFeeSource==='shopify'?'Shopify transaction timeline':selected.paymentFeeSource==='manual'?'Manual override':'No Shopify Payments fee available'}</strong>{(selected.paymentFeeBreakdown||[]).map((fee,i)=><div key={fee.transactionId+'-'+i}><span>{fee.type.replace(/_/g,' ')}</span><strong>{money(fee.amount)}{fee.originalCurrency!==selected.currency?' · '+fee.originalCurrency+' '+Number(fee.originalAmount).toFixed(2):''}</strong></div>)}<small>Store credit cost source: {selected.cashbackSource==='shopify-metafield'?'dollar-cashback.store-credit-given':selected.cashbackSource==='manual'?'Manual override':'Not available'}</small></div>
        <div className="platform-fields">{inputs.map(([key,label])=><label key={key}><span>{label}</span><div className="platform-money-input"><span>$</span><input type="number" min="0" step="0.01" required disabled={saving||!status?.ownerAuthenticated} value={values[key]??'0'} onChange={e=>setValues(v=>({...v,[key]:e.target.value}))}/></div></label>)}</div>
        <label className="platform-notes"><span>Internal notes</span><textarea rows="3" disabled={saving||!status?.ownerAuthenticated} value={values.notes||''} onChange={e=>setValues(v=>({...v,notes:e.target.value}))} placeholder="Carrier, tracking, cashback details, fees…"/></label>
      </form>
      <div className="platform-breakdown"><div><span>Revenue</span><strong>{money(preview.revenue)}</strong></div><div><span>Variable costs</span><strong>−{money(preview.revenue-preview.takeHome)}</strong></div><div><span>Net take-home before COGS</span><strong>{money(preview.takeHome)}</strong></div><div><span>Product COGS</span><strong>−{money(selected.cogs)}</strong></div><div className="platform-profit"><span>Final contribution profit</span><strong className={preview.profit<0?'negative':'positive'}>{money(preview.profit)}</strong></div><small>{pct(preview.margin)} margin · {selected.costsReviewed?'Costs previously reviewed':'Save costs to mark as reviewed'}</small></div>
      <NavLink className="platform-detail-link" to={'/orders/'+selected._id}>Edit item-level COGS and view all line items <ExternalLink size={14}/></NavLink>
      </div>
      <div className="platform-drawer-footer"><button className="secondary" onClick={close} disabled={saving}>Close</button><button type="submit" form="platform-cost-form" disabled={saving||!status?.ownerAuthenticated}><Save size={15}/>{saving?'Saving…':'Save actual costs'}</button></div>
    </section></div>}
  </>;
}
