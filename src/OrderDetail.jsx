import React,{useEffect,useState} from 'react';
import {NavLink,useNavigate,useParams} from 'react-router-dom';
import {Plus,Pencil,Save,RefreshCw,ExternalLink,Trash2} from 'lucide-react';
import {api,money,pct,dateFmt} from './api.js';
import {InputField,SignInNotice} from './LedgerRecords.jsx';
import ManualSaleEditor from './ManualSaleEditor.jsx';
import PaymentStatus from './PaymentStatus.jsx';
import SaleRemovalDialog from './SaleRemovalDialog.jsx';

export default function OrderDetail(){
  const {id}=useParams(),navigate=useNavigate(),[order,setOrder]=useState(null),[access,setAccess]=useState(null),[error,setError]=useState(''),[editing,setEditing]=useState(false),[message,setMessage]=useState(''),[removal,setRemoval]=useState(null);
  const load=async()=>{setError('');try{const [record,status]=await Promise.all([api(`/api/orders/${id}`),api('/api/status')]);setOrder(record);setAccess(status);}catch(error){setError(error.message);}};
  useEffect(()=>{load();},[id]);
  if(!order)return <div className="loading">{error||'Loading order…'}{error&&<button className="secondary" onClick={load}>Reload</button>}</div>;
  const revenue=(order.netSales||0)+(order.shippingRevenue||0),profit=revenue-(order.cogs||0)-(order.shippingCost||0)-(order.paymentFees||0)-(order.materialCost||0)-(order.otherVariableCost||0);
  const shopifyOrderId=order.shopifyId?.match(/\/Order\/(\d+)$/)?.[1];
  const saved=record=>{setOrder(record);setEditing(false);setMessage('Changes saved. Reports now use the updated sale.');};
  return <>
    <header><div><div className="order-name-payment"><h1>{order.name||order.orderNumber}</h1><PaymentStatus order={order} onSaved={setOrder}/></div><p>{dateFmt(order.createdAtShopify)} · {order.source==='manual'?'Manual sale':'Shopify order'}</p></div><div className="actions">
      {order.source==='manual'?<><button onClick={()=>setEditing('edit')} disabled={!access?.ownerAuthenticated}><Pencil size={15}/>Edit sale</button><button className="secondary" onClick={()=>setEditing('add')} disabled={!access?.ownerAuthenticated}><Plus size={15}/>Add item</button><button className="secondary danger" onClick={()=>setRemoval({})} disabled={!access?.ownerAuthenticated}><Trash2 size={15}/>Cancel / remove sale</button></>:shopifyOrderId&&access?.shop&&<a className="secondary button" href={`https://${access.shop}/admin/orders/${shopifyOrderId}`} target="_blank" rel="noopener noreferrer"><ExternalLink size={15}/>Open in Shopify</a>}
      <NavLink className="secondary button" to="/orders">Back to orders</NavLink></div></header>
    <SignInNotice access={access}/>{error&&<div className="notice" role="alert">{error}</div>}{message&&<div className="inventory-note inventory-saved" role="status">{message}</div>}
    <section className="kpi-grid three">{[['Revenue',money(revenue),`Collected ${money(order.totalCollected)}`],['COGS',money(order.cogs),`${order.lines.length} line items`],['Contribution profit',money(profit),revenue?`${pct(profit/revenue*100)} margin`:'—']].map(([label,value,sub])=><div className="kpi" key={label}><div className="kpi-label">{label}</div><div className="kpi-value">{value}</div><div className="kpi-sub">{sub}</div></div>)}</section>
    <OrderCosts key={order.updatedAt} order={order} access={access} onSaved={saved} onRemove={index=>setRemoval({index})}/>
    {removal&&<SaleRemovalDialog order={order} index={removal.index} onClose={()=>setRemoval(null)} onSaved={record=>{saved(record);setRemoval(null);}} onRemoved={()=>navigate('/orders',{replace:true})}/>}
    {editing&&<ManualSaleEditor record={order} addItem={editing==='add'} onClose={()=>setEditing(false)} onSaved={saved}/>}
  </>;
}
function OrderCosts({order,access,onSaved,onRemove}){
  const [values,setValues]=useState(()=>Object.fromEntries(['shippingCost','paymentFees','materialCost','otherVariableCost','notes'].map(key=>[key,order[key]??(key==='notes'?'':0)])));
  const [lineCosts,setLineCosts]=useState(()=>order.lines.map(line=>line.unitCost??0)),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const save=async event=>{event.preventDefault();setBusy(true);setError('');try{onSaved(await api(`/api/orders/${order._id}`,{method:'PATCH',body:JSON.stringify({...values,expectedUpdatedAt:order.updatedAt,lineCosts:lineCosts.map((unitCost,index)=>({index,unitCost:Number(unitCost)}))})}));}catch(error){setError(error.message);}finally{setBusy(false);}};
  const previewCogs=lineCosts.reduce((sum,cost,index)=>sum+(Number(cost)||0)*order.lines[index].quantity,0);
  return <form className="grid-main order-cost-editor" onSubmit={save}>
    <div className="panel"><div className="panel-head"><div><h2>Line items & costs</h2><p>Unit cost changes apply to this sale and remain saved through future syncs.</p></div></div>
      <div className="tablewrap"><table><thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Sales</th><th className="num">Order unit cost</th><th className="num">COGS</th>{order.source==='manual'&&<th>Actions</th>}</tr></thead><tbody>
        {order.lines.map((line,index)=><tr key={line.shopifyLineId||index}><td><strong>{line.title}</strong><div className="small">{[line.variantTitle,line.sku].filter(Boolean).join(' · ')}</div></td><td className="num">{line.quantity}</td><td className="num">{money(line.net)}</td><td className="num"><input className="inline-cost-input" aria-label={`Unit cost for ${line.title}`} type="number" min="0" step="0.0001" required disabled={busy||!access?.ownerAuthenticated} value={lineCosts[index]} onChange={event=>setLineCosts(previous=>previous.map((value,i)=>i===index?event.target.value:value))}/></td><td className="num">{money((Number(lineCosts[index])||0)*line.quantity)}</td>{order.source==='manual'&&<td><button className="secondary danger" type="button" disabled={busy||!access?.ownerAuthenticated} onClick={()=>onRemove(index)}><Trash2 size={14}/>Remove item</button></td>}</tr>)}
      </tbody></table></div><div className="record-summary"><span>Total item costs</span><strong>{money(previewCogs)}</strong></div>
      {order.source==='shopify'&&<p className="record-help">Use Open in Shopify to edit the order’s products, discounts, or sale status.</p>}
      {order.source==='manual'&&<p className="record-help">Use Add item to add products, Remove item to cancel a row, or Edit sale to change quantities, prices and tax.</p>}
    </div>
    <div className="panel"><div className="panel-head"><div><h2>Order costs & notes</h2><p>Save item costs, fulfilment costs and notes together.</p></div></div>
      {error&&<div className="notice" role="alert">{error}</div>}
      <fieldset className="record-fieldset" disabled={busy||!access?.ownerAuthenticated}><div className="formgrid one">{[['shippingCost','Shipping cost'],['paymentFees','Payment fees'],['materialCost','Packing materials'],['otherVariableCost','Other variable cost']].map(([name,label])=><InputField key={name} field={{name,label,type:'number'}} value={values[name]} onChange={value=>setValues({...values,[name]:value})}/>)}
        <InputField field={{name:'notes',label:'Internal notes',type:'textarea',wide:true}} value={values.notes} onChange={value=>setValues({...values,notes:value})}/><button disabled={busy||!access?.ownerAuthenticated}>{busy?<RefreshCw size={15} className="spin"/>:<Save size={15}/>} {busy?'Saving…':'Save order changes'}</button>
      </div></fieldset>
    </div>
  </form>;
}

