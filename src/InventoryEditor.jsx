import React, {useEffect, useRef, useState} from 'react';
import {RefreshCw, X} from 'lucide-react';
import {api} from './api.js';

export default function InventoryEditor({row, access, onClose, onSaved}) {
  const dialog = useRef(null);
  const [initial, setInitial] = useState(null), [price, setPrice] = useState(''), [cost, setCost] = useState('');
  const [quantities, setQuantities] = useState({}), [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  const load = async () => {
    setLoading(true); setError('');
    try {
      const item = await api(`/api/inventory/${row._id}/edit`);
      setInitial(item); setPrice(item.price.toFixed(2)); setCost(item.unitCost == null ? '' : String(item.unitCost));
      setQuantities(Object.fromEntries(item.locations.map(location => [location.id, String(location.quantity)])));
    } catch (error) {setError(error.message);}
    finally {setLoading(false);}
  };
  useEffect(() => {dialog.current.showModal(); if (access.allowed) load();}, []);
  const changes = () => {
    if (!initial) return {};
    const body = {expected:{price:initial.price, unitCost:initial.unitCost}};
    if (Number(price) !== initial.price) body.price = price;
    if (cost !== '' && Number(cost) !== initial.unitCost) body.unitCost = cost;
    const locations = initial.locations.filter(location => quantities[location.id] !== String(location.quantity))
      .map(location => ({locationId:location.id, quantity:Number(quantities[location.id]), expectedQuantity:location.quantity}));
    if (locations.length) body.locations = locations;
    return body;
  };
  const dirty = Object.keys(changes()).length > 1;
  const save = async event => {
    event.preventDefault(); if (saving || !dirty) return;
    setSaving(true); setError('');
    try {
      const result = await api(`/api/inventory/${row._id}`, {method:'PATCH', body:JSON.stringify(changes())});
      onSaved(result);
    } catch (error) {setError(error.message);}
    finally {setSaving(false);}
  };
  return <dialog ref={dialog} className="inventory-edit-dialog" onCancel={event => {event.preventDefault(); if (!saving) onClose();}}>
    <form onSubmit={save}>
      <div className="modal-head"><h2>Edit product</h2><button type="button" className="icon" aria-label="Close editor" disabled={saving} onClick={onClose}><X size={18}/></button></div>
      <div className="inventory-edit-title"><strong>{row.title}</strong>{row.variantTitle !== 'Default Title' && <span>{row.variantTitle}</span>}</div>
      {!access.allowed ? <div className="inventory-enable"><p>Sign in through Shopify and approve editing access to update your store’s prices, costs and inventory.</p><a className="button" href={access.authUrl}>Enable Shopify editing</a></div> : <>
        <p className="inventory-editor-copy">Changes save directly to Shopify. Amounts are in {initial?.currency || row.currency}; stock is available quantity at each location.</p>
        {error && <div className="notice" role="alert"><div><strong>Could not complete this request</strong><span>{error}</span></div><button type="button" className="secondary" disabled={saving || loading} onClick={load}>Reload values</button></div>}
        {loading ? <div className="loading">Loading current Shopify values…</div> : initial && <fieldset disabled={saving} className="inventory-edit-fields">
          <div className="formgrid"><label><span>Price ({initial.currency})</span><input type="number" min="0" step="0.01" required value={price} onChange={event => setPrice(event.target.value)}/></label>
          <label><span>Unit cost ({initial.currency})</span><input type="number" min="0" step="0.0001" required={initial.unitCost != null} placeholder="No cost set" value={cost} onChange={event => setCost(event.target.value)}/></label></div>
          <h3>Available inventory</h3>
          {!initial.tracked ? <p className="inventory-editor-copy">Inventory is untracked in Shopify. Enable inventory tracking there before changing stock here.</p> : !initial.locations.length ? <p className="inventory-editor-copy">This variant is not stocked at a location. Add a location in Shopify first.</p> :
            <div className="formgrid one">{initial.locations.map(location => <label key={location.id}><span>{location.name}{!location.active ? ' (inactive)' : ''}</span><input type="number" step="1" required disabled={!location.active} value={quantities[location.id] ?? ''} onChange={event => setQuantities({...quantities,[location.id]:event.target.value})}/></label>)}</div>}
        </fieldset>}
      </>}
      <div className="modal-actions"><button type="button" className="secondary" disabled={saving} onClick={onClose}>Cancel</button>{access.allowed && <button type="submit" disabled={saving || loading || !initial || !dirty}>{saving ? <><RefreshCw size={15} className="spin"/>Saving to Shopify…</> : 'Save to Shopify'}</button>}</div>
    </form>
  </dialog>;
}
