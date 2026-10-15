import test from 'node:test';
import assert from 'node:assert/strict';
import {refreshGrantedScopes, editingReturnUrl} from './owner-auth.js';

test('OAuth completion reports missing write grants instead of silently returning success',()=>{
  assert.equal(editingReturnUrl('read_products,read_inventory'),'/inventory?editing=permissions-required');
  assert.equal(editingReturnUrl('write_products,read_inventory'),'/inventory?editing=permissions-required');
  assert.equal(editingReturnUrl('write_products,write_inventory'),'/inventory?editing=enabled');
});

test('scope refresh stores the permissions Shopify actually grants',async()=>{
  let update;
  const scope=await refreshGrantedScopes('test.myshopify.com',{
    gql:async()=>({currentAppInstallation:{accessScopes:[{handle:'write_products'},{handle:'write_inventory'}]}}),
    Session:{updateOne:async(...args)=>{update=args;}}
  });
  assert.equal(scope,'write_products,write_inventory');
  assert.deepEqual(update,[{shop:'test.myshopify.com'},{$set:{scope}}]);
});

test('a failed or malformed Shopify permission check cannot overwrite known grants',async()=>{
  let writes=0;
  for(const gql of [async()=>{throw new Error('Network error');},async()=>({}),async()=>({currentAppInstallation:{accessScopes:[{}]}})]){
    await assert.rejects(refreshGrantedScopes('test.myshopify.com',{gql,Session:{updateOne:async()=>{writes++;}}}));
  }
  assert.equal(writes,0);
});
