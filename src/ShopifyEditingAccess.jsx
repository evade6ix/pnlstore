import React, {useState} from 'react';
import {api} from './api.js';

export default function ShopifyEditingAccess({access, onChecked}) {
  const [busy,setBusy] = useState(false), [message,setMessage] = useState('');
  const check = async () => {
    setBusy(true); setMessage('');
    try {
      const result = await api('/api/inventory/access', {method:'POST',body:'{}'});
      onChecked(result);
      setMessage(result.allowed ? 'Shopify editing is enabled.' : `Shopify still hasn’t granted: ${result.missingScopes.join(', ')}. Update and release the app’s permissions first.`);
    } catch(error) {setMessage(error.message);}
    finally {setBusy(false);}
  };
  if (!access.authenticated) return <div className="notice"><div><strong>Edit your Shopify products here</strong><span>Sign in through Shopify to enable price, cost and stock changes.</span></div><a className="button" href={access.authUrl}>Enable Shopify editing</a></div>;
  return <div className="inventory-permissions" role="status">
    <strong>Shopify sign-in succeeded. Editing permissions are still missing.</strong>
    <p>Shopify is granting this app read access. To enable saves, update the app’s configuration:</p>
    <ol><li>Open the <a href="https://dev.shopify.com/dashboard" target="_blank" rel="noopener noreferrer">Shopify Dev Dashboard</a> and select the app connected to pnlstore.</li>
      <li>Under <strong>Versions</strong>, create a new version. In <strong>Access / Scopes</strong>, add <code>write_products</code> and <code>write_inventory</code> alongside the existing permissions, then <strong>Release</strong> it.</li>
      <li>Open the app from your Shopify admin and approve its updated permissions.</li></ol>
    <p className="small">Missing from the current token: {access.missingScopes.join(', ')}</p>
    <div className="inventory-permission-actions"><button className="secondary" disabled={busy} onClick={check} type="button">{busy?'Checking Shopify…':'Check permissions again'}</button><a className="textlink" href={access.authUrl}>Reconnect after updating permissions</a></div>
    {message && <p role="status">{message}</p>}
  </div>;
}
