import React, {useEffect, useState} from 'react';
import {RefreshCw, Search, PackageSearch, AlertCircle, Pencil} from 'lucide-react';
import {api, pct} from './api.js';
import InventoryEditor from './InventoryEditor.jsx';

export default function Inventory() {
  const [data, setData] = useState(null), [query, setQuery] = useState('');
  const [page, setPage] = useState(1), [inStock, setInStock] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [editing, setEditing] = useState(null), [saved, setSaved] = useState('');
  const url = `/api/inventory?q=${encodeURIComponent(query)}&page=${page}${inStock ? '&inStock=1' : ''}`;
  useEffect(() => {
    let alive = true;
    const load = () => api(url).then(result => {if (alive) {setData(result); setError('');}})
      .catch(error => {if (alive) setError(error.message);});
    const debounce = setTimeout(load, 200), interval = setInterval(load, 30000);
    return () => {alive = false; clearTimeout(debounce); clearInterval(interval);};
  }, [url]);
  const sync = async () => {
    setBusy(true); setError('');
    try {await api('/api/sync/inventory', {method:'POST'}); setData(await api(url));}
    catch (error) {setError(error.message);}
    finally {setBusy(false);}
  };
  const onSaved = async result => {
    setEditing(null); setSaved(result.message); setError('');
    try {setData(await api(url));}
    catch {setError('Your changes were saved to Shopify. Refresh this page to update the table.');}
  };
  const totals = data?.totals, state = data?.sync;
  const currency = state?.currency || 'CAD';
  const money = n => n == null ? '—' : new Intl.NumberFormat('en-CA', {style:'currency', currency}).format(n);
  const pages = Math.max(1, Math.ceil((data?.total || 0) / 50));
  const actualPage = data?.page || page;
  const partial = totals?.missingCostStock > 0;
  return <>
    <header><div><h1>Inventory</h1><p>Your Shopify catalog, stock value and potential gross profit.</p></div>
      <button className="secondary" onClick={sync} disabled={busy}><RefreshCw size={16} className={busy ? 'spin' : ''}/>{busy ? 'Syncing…' : 'Sync products'}</button>
    </header>
    <div className="inventory-sync"><span className="inventory-sync-dot"/>
      <span>Automatic sync every {data?.refreshMinutes || 5} minutes · {state?.lastSyncedAt ? `Last synced ${new Date(state.lastSyncedAt).toLocaleString()}` : 'Waiting for first import'}</span>
      <span>{currency} · All product statuses</span>
    </div>
    {saved && <div className="inventory-note inventory-saved" role="status">{saved}</div>}
    {data?.editing && !data.editing.allowed && <div className="notice"><div><strong>Edit your Shopify products here</strong><span>Enable editing once to save price, cost and stock changes directly to Shopify.</span></div><a className="button" href={data.editing.authUrl}>Enable Shopify editing</a></div>}
    {(error || state?.error) && <div className="notice" role="alert"><AlertCircle size={18}/><div><strong>Sync needs attention</strong><span>{error || state.error}</span></div><button className="secondary" disabled={busy} onClick={sync}>Retry sync</button></div>}
    <section className="kpi-grid">
      <Stat label="Total inventory value" value={money(totals?.inventoryValue)} sub="Selling price × available quantity"/>
      <Stat label={partial ? 'Known inventory cost' : 'Total inventory cost'} value={money(totals?.inventoryCost)} sub={partial ? 'Incomplete — some stocked items have no cost' : 'Shopify unit cost × available quantity'}/>
      <Stat label={partial ? 'Known potential gross profit' : 'Potential gross profit'} value={money(totals?.totalProfit)} sub={totals?.margin == null ? 'Margin unavailable' : `${pct(totals.margin)} gross margin${partial ? ' · known costs only' : ''}`} tone={totals?.totalProfit < 0 ? 'negative' : 'positive'}/>
      <Stat label="Available units" value={totals ? totals.quantity.toLocaleString() : '—'} sub={`${state?.products ?? '—'} products · ${totals?.variants ?? '—'} variants`}/>
    </section>
    {(totals?.missingCosts > 0 || totals?.untracked > 0) && <div className="inventory-note">
      {totals.missingCosts > 0 && <span>{totals.missingCosts} variant(s) have no Shopify cost. Their profit is unavailable; add a cost in Shopify to include them in cost and profit totals.</span>}
      {totals.untracked > 0 && <span>{totals.untracked} variant(s) have untracked inventory and are excluded from stock valuation.</span>}
    </div>}
    <div className="toolbar inventory-toolbar"><div className="search"><Search size={17}/><input aria-label="Search products" placeholder="Search title, variant or SKU…" value={query} onChange={event => {setQuery(event.target.value); setPage(1);}}/></div>
      <label className="inventory-filter"><input type="checkbox" checked={inStock} onChange={event => {setInStock(event.target.checked); setPage(1);}}/>In stock only</label>
      <span className="count">{data?.total ?? '—'} variants{query || inStock ? ' matching' : ''}</span>
    </div>
    <section className="panel flush"><div className="tablewrap"><table className="inventory-table"><thead><tr>
      <th>Image</th><th>Product</th><th className="num">Price</th><th className="num">Unit cost</th><th className="num">Qty</th><th className="num">Gross profit %</th><th className="num">Total gross profit $</th><th>Actions</th>
    </tr></thead><tbody>
      {data?.items.map(row => <tr key={row.variantId}>
        <td><div className="product-thumbnail">{row.imageUrl ? <img src={row.imageUrl} alt={row.imageAlt} loading="lazy" onError={event => {event.currentTarget.style.display = 'none';}}/> : <PackageSearch size={22}/>}</div></td>
        <td className="inventory-product"><strong>{row.title}</strong>{row.variantTitle !== 'Default Title' && <div className="small">{row.variantTitle}</div>}<div className="small">{row.sku || 'No SKU'} · {row.status?.toLowerCase()}</div></td>
        <td className="num">{money(row.price)}</td><td className="num">{row.unitCost == null ? <span className="missing-cost">Missing cost</span> : money(row.unitCost)}</td>
        <td className={`num ${row.quantity < 0 ? 'negative' : ''}`}>{row.quantity ?? 'Untracked'}</td>
        <td className={`num ${row.margin < 0 ? 'negative' : ''}`}>{row.margin == null ? '—' : pct(row.margin)}</td>
        <td className={`num strong ${row.totalProfit == null ? '' : row.totalProfit < 0 ? 'negative' : 'positive'}`}>{money(row.totalProfit)}</td>
        <td><button className="secondary inventory-edit-button" onClick={() => {setSaved(''); setEditing(row);}} aria-label={`Edit ${row.title}${row.variantTitle === 'Default Title' ? '' : ` ${row.variantTitle}`}`}><Pencil size={13}/>Edit</button></td>
      </tr>)}
      {!data?.items.length && <tr><td colSpan="8" className="empty">{!data ? 'Loading inventory…' : state?.lastSyncedAt ? 'No products match these filters.' : 'Your catalog is importing. Click Sync products to retry now.'}</td></tr>}
    </tbody></table></div>
    <div className="inventory-pagination"><span>Page {actualPage} of {pages}</span><div><button className="secondary" disabled={actualPage <= 1} onClick={() => setPage(actualPage - 1)}>Previous</button><button className="secondary" disabled={actualPage >= pages} onClick={() => setPage(actualPage + 1)}>Next</button></div></div>
    </section>
    <p className="inventory-footnote">Totals cover the full catalog, regardless of search or page. Quantity is Shopify’s available stock across locations; negative quantities count as zero for valuation. Gross margin = (price − cost) ÷ price. Total gross profit = (price − cost) × available quantity, before fees, shipping and tax.</p>
    {editing && <InventoryEditor row={editing} access={data.editing} onClose={() => setEditing(null)} onSaved={onSaved}/>}
  </>;
}
function Stat({label, value, sub, tone = ''}) {
  return <div className="kpi"><div className="kpi-label">{label}</div><div className={`kpi-value ${tone}`}>{value}</div><div className="kpi-sub">{sub}</div></div>;
}
