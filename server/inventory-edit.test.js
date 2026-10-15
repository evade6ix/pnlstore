import test from 'node:test';
import assert from 'node:assert/strict';
import {buildVariantUpdate, createInventoryEditor, EDIT_MUTATION} from './inventory-edit.js';
import {ownerToken, verifyOwnerToken, editingAccess, safeEqual} from './owner-auth.js';

const shop = 'example.myshopify.com';
const current = {variantId:'gid://shopify/ProductVariant/1',productId:'gid://shopify/Product/1',price:19.95,unitCost:14.25,tracked:true,
  locations:[{id:'loc-1',name:'Shop',quantity:5,active:true},{id:'loc-2',name:'Warehouse',quantity:8,active:true}]};
const expected = {price:19.95,unitCost:14.25};

test('price, cost, and chosen location stock use one Shopify mutation with compare-and-swap', () => {
  assert.deepEqual(buildVariantUpdate(current,{expected,price:'20.95',unitCost:'13.50',locations:[{locationId:'loc-2',quantity:10,expectedQuantity:8}]}), {
    id:current.variantId,price:'20.95',inventoryItem:{cost:'13.5'},quantityAdjustments:[{locationId:'loc-2',adjustment:2,changeFromQuantity:8}]
  });
  assert.deepEqual(buildVariantUpdate(current,{expected,unitCost:0}), {id:current.variantId,inventoryItem:{cost:'0'}});
  assert.deepEqual(buildVariantUpdate(current,{expected,locations:[{locationId:'loc-1',quantity:0,expectedQuantity:5}]}).quantityAdjustments,
    [{locationId:'loc-1',adjustment:-5,changeFromQuantity:5}]);
});

test('unchanged fields never overwrite unrelated Shopify changes', () => {
  assert.deepEqual(buildVariantUpdate(current,{expected}),{id:current.variantId});
  assert.deepEqual(buildVariantUpdate({...current,price:22},{expected,unitCost:12}),{id:current.variantId,inventoryItem:{cost:'12'}});
});

test('stale price, cost, and inventory values are rejected', () => {
  assert.throws(()=>buildVariantUpdate({...current,price:21},{expected,price:25}), error=>error.status===409);
  assert.throws(()=>buildVariantUpdate({...current,unitCost:15},{expected,unitCost:12}), error=>error.status===409);
  assert.throws(()=>buildVariantUpdate(current,{expected,locations:[{locationId:'loc-1',quantity:10,expectedQuantity:4}]}),/Stock changed/);
});

test('invalid numbers, fractional stock, duplicate/unknown locations, and untracked inventory are rejected', () => {
  for(const value of ['',null,-1,NaN,Infinity,'bad']) assert.throws(()=>buildVariantUpdate(current,{expected,price:value}));
  const change={locationId:'loc-1',quantity:7,expectedQuantity:5};
  assert.throws(()=>buildVariantUpdate(current,{expected,locations:[{...change,quantity:1.5}]}));
  assert.throws(()=>buildVariantUpdate(current,{expected,locations:[change,change]}));
  assert.throws(()=>buildVariantUpdate(current,{expected,locations:[{...change,locationId:'unknown'}]}));
  assert.throws(()=>buildVariantUpdate({...current,tracked:false},{expected,locations:[change]}));
});

test('only a signed, unexpired owner cookie for this shop plus write scopes enables editing', () => {
  const secret='test-secret',token=ownerToken(shop,secret);
  const req={headers:{cookie:`pnl_owner=${token}`}};
  assert.equal(verifyOwnerToken(token,shop,secret),true);
  assert.equal(verifyOwnerToken(token,'other.myshopify.com',secret),false);
  assert.equal(verifyOwnerToken(token,shop,'other-secret'),false);
  assert.equal(verifyOwnerToken(token+'tamper',shop,secret),false);
  assert.equal(verifyOwnerToken(ownerToken(shop,secret,0),shop,secret),false);
  assert.equal(editingAccess(req,shop,'write_products,write_inventory',secret).allowed,true);
  assert.equal(editingAccess(req,shop,'read_products,read_inventory',secret).allowed,false);
  assert.equal(editingAccess({headers:{}},shop,'write_products,write_inventory',secret).allowed,false);
  assert.equal(safeEqual('x','xx'),false);
  assert.equal(safeEqual(null,null),false);
});

function harness({reject=false,timeout=false,refreshFails=false}={}) {
  const calls=[],updates=[],syncs=[];
  let changed=false;
  const editor=createInventoryEditor({
    gql:async (shop,query,variables)=>{
      calls.push({query,variables});
      if(query===EDIT_MUTATION){
        if(timeout)throw new Error('Timeout');
        if(reject)return {productVariantsBulkUpdate:{userErrors:[{message:'Stock changed'}],productVariants:[]}};
        changed=true;
        return {productVariantsBulkUpdate:{userErrors:[],productVariants:[{id:current.variantId}]}};
      }
      return {shop:{currencyCode:'CAD'},productVariant:{id:current.variantId,title:'Default Title',sku:null,price:changed?'20.95':'19.95',inventoryQuantity:5,
        inventoryItem:{id:'inventory-1',tracked:true,unitCost:{amount:'14.25',currencyCode:'CAD'},inventoryLevels:{nodes:[{location:{id:'loc-1',name:'Shop',isActive:true},quantities:[{name:'available',quantity:5}]}],pageInfo:{hasNextPage:false}}},
        product:{id:current.productId,title:'Product',status:'ACTIVE',featuredMedia:null}}};
    },
    Catalog:{updateOne:async (...args)=>updates.push(args)},
    syncCatalog:async (...args)=>{syncs.push(args);if(refreshFails)throw new Error('Sync offline');}
  });
  return {editor,calls,updates,syncs};
}

test('save verifies Shopify values, then refreshes the catalog and totals', async () => {
  const h=harness();
  const result=await h.editor.save(shop,current,{expected,price:20.95});
  assert.equal(result.saved,true);
  assert.equal(result.item.price,20.95);
  assert.equal(h.calls.filter(call=>call.query===EDIT_MUTATION).length,1);
  assert.equal(h.updates.length,1);
  assert.deepEqual(h.syncs,[[shop,{fresh:true}]]);
});

test('Shopify rejection never changes the local catalog or reports success', async () => {
  const h=harness({reject:true});
  await assert.rejects(h.editor.save(shop,current,{expected,price:20.95}),/Stock changed/);
  assert.equal(h.updates.length,0);
  assert.equal(h.syncs.length,0);
});

test('an uncertain write is not retried automatically', async () => {
  const h=harness({timeout:true});
  await assert.rejects(h.editor.save(shop,current,{expected,price:20.95}),/Reload the editor/);
  assert.equal(h.calls.filter(call=>call.query===EDIT_MUTATION).length,1);
});

test('a successful Shopify save with a later refresh failure is reported accurately', async () => {
  const h=harness({refreshFails:true});
  const result=await h.editor.save(shop,current,{expected,price:20.95});
  assert.equal(result.saved,true);
  assert.match(result.message,/Saved to Shopify/);
  assert.equal(result.warning,'Sync offline');
});
