import React,{useEffect,useState} from 'react';
import {Plus,Search} from 'lucide-react';
import {api} from './api.js';
import OrderTable from './OrderTable.jsx';
import ManualSaleEditor from './ManualSaleEditor.jsx';

export default function Orders(){
  const [query,setQuery]=useState(''),[page,setPage]=useState(1),[data,setData]=useState({items:[],total:0,limit:50}),[editing,setEditing]=useState(false),[error,setError]=useState('');
  useEffect(()=>{let alive=true;const timer=setTimeout(()=>api(`/api/orders?q=${encodeURIComponent(query)}&page=${page}`).then(result=>{if(alive){setData(result);setError('');}}).catch(error=>{if(alive)setError(error.message);}),200);return()=>{alive=false;clearTimeout(timer);};},[query,page]);
  const pages=Math.max(1,Math.ceil(data.total/data.limit));
  const saved=async()=>{setEditing(false);setPage(1);try{setData(await api(`/api/orders?q=${encodeURIComponent(query)}&page=1`));}catch(error){setError(error.message);}};
  return <>
    <header><div><h1>Orders</h1><p>Open any sale to edit its costs, notes or manual sale details.</p></div><button onClick={()=>setEditing(true)}><Plus size={16}/>Manual sale</button></header>
    {error&&<div className="notice" role="alert">{error}</div>}
    <div className="toolbar"><div className="search"><Search size={17}/><input aria-label="Search orders" placeholder="Search order number or SKU…" value={query} onChange={event=>{setQuery(event.target.value);setPage(1);}}/></div><span className="count">{data.total} orders</span></div>
    <section className="panel flush"><OrderTable items={data.items}/><div className="inventory-pagination"><span>Page {page} of {pages}</span><div><button className="secondary" disabled={page<=1} onClick={()=>setPage(page-1)}>Previous</button><button className="secondary" disabled={page>=pages} onClick={()=>setPage(page+1)}>Next</button></div></div></section>
    {editing&&<ManualSaleEditor onClose={()=>setEditing(false)} onSaved={saved}/>}
  </>;
}
