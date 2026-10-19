import test from 'node:test';
import assert from 'node:assert/strict';
import {createManualSaleHandlers,manualSaleInventoryDeltas} from './ledger.js';
import {Catalog} from './models.js';

const id='000000000000000000000001',stamp='2026-10-19T13:00:00.000Z';
const line=(variantId,quantity=1,extra={})=>({variantId,title:'Test item',quantity,gross:quantity*20,discount:0,net:quantity*20,unitCost:5,cogs:quantity*5,costSource:'order-edit',...extra});
function setup(lines,overrides={}){
  let record={_id:id,source:'manual',name:'Event sale',orderNumber:'MAN-1',createdAtShopify:new Date(stamp),updatedAt:new Date(stamp),netSales:60,shippingRevenue:0,taxes:7.8,lines,...overrides};
  let tick=Date.parse(stamp),writes=0,failCommit=false;
  const clone=value=>value?structuredClone(value):null;
  const match=filter=>record&&Object.entries(filter).every(([key,value])=>value instanceof Date?+new Date(record[key])===+value:value===null?record[key]==null:record[key]===value);
  const Order={
    findOne:filter=>({lean:async()=>match(filter)?clone(record):null}),
    findOneAndUpdate:async(filter,update)=>{
      if(!match(filter))return null;
      if(failCommit&&update.$set?.lines)throw new Error('Database save failed');
      record={...record,...update.$set,updatedAt:new Date(++tick)};writes++;return clone(record);
    },
    findOneAndDelete:async filter=>{if(!match(filter))return null;const old=clone(record);record=null;writes++;return old;}
  };
  const adjustments=[];
  const adjust=async(shop,deltas)=>{adjustments.push(structuredClone(deltas));};
  const hydrate=async(body,shop,current)=>({...body,lines:body.lines.map(item=>item.originalIndex==null?item:{...current.lines[item.originalIndex],...item})});
  const handlers=createManualSaleHandlers({Order,shop:()=> 'test.myshopify.com',hydrate,adjust});
  return {Order,adjust,hydrate,adjustments,handlers,get record(){return clone(record);},get writes(){return writes;},set failCommit(value){failCommit=value;}};
}

test('per-row return choices distinguish duplicate variants and new replacement items',()=>{
  const previous=[line('A',2),line('A',3),line('B',1)];
  const next=[line('B',1),line('A',1)];
  const request=[{originalIndex:2},{}];
  assert.deepEqual(manualSaleInventoryDeltas(previous,next,request,[{index:0,restock:true},{index:1,restock:false}]),[{variantId:'A',soldDelta:-1}]);
  assert.deepEqual(manualSaleInventoryDeltas([line('A')],[line('A')],[{}],[{index:0,restock:false}]),[{variantId:'A',soldDelta:1}]);
});

test('quantity decreases return only the removed quantity and increases remove only the extra stock',()=>{
  const old=[line('A',4),line('B',1)];
  const next=[line('A',2),line('B',3)];
  const request=[{originalIndex:0},{originalIndex:1}];
  assert.deepEqual(manualSaleInventoryDeltas(old,next,request,[{index:0,restock:true}]),[{variantId:'B',soldDelta:2},{variantId:'A',soldDelta:-2}]);
  assert.deepEqual(manualSaleInventoryDeltas(old,next,request,[{index:0,restock:false}]),[{variantId:'B',soldDelta:2}]);
});

test('missing, duplicate and malformed inventory choices or original row identities are rejected',()=>{
  const old=[line('A',2)];
  assert.throws(()=>manualSaleInventoryDeltas(old,[],[],[]),/Choose whether/);
  for(const choices of [[{index:0,restock:'false'}],[{index:99,restock:true}],[{index:0,restock:true},{index:0,restock:false}],null])assert.throws(()=>manualSaleInventoryDeltas(old,[],[],choices));
  assert.throws(()=>manualSaleInventoryDeltas(old,[line('B')],[{originalIndex:0}],[]),/original sale item/);
  assert.throws(()=>manualSaleInventoryDeltas(old,[line('A'),line('A')],[{originalIndex:0},{originalIndex:0}],[]),/original sale item/);
});

test('cancelling a sale returns all, none or selected duplicate-variant rows as requested',async()=>{
  for(const choices of [[true,true],[false,false],[true,false]]){
    const state=setup([line('A',2),line('A',3)]);
    await state.handlers.remove(id,{expectedUpdatedAt:stamp,restockChoices:choices.map((restock,index)=>({index,restock}))});
    const total=(choices[0]?2:0)+(choices[1]?3:0);
    assert.deepEqual(state.adjustments,[total?[{variantId:'A',soldDelta:-total}]:[]]);
    assert.equal(state.record,null);
    await assert.rejects(state.handlers.remove(id,{expectedUpdatedAt:stamp,restockChoices:[]}),/not found/);
    assert.equal(state.adjustments.length,1);
  }
});

test('remove one row, keep inventory, then cancel the rest without returning the removed row twice',async()=>{
  const state=setup([line('A',2),line('B',1)]);
  const saved=await state.handlers.update(id,{expectedUpdatedAt:stamp,lines:[{...line('B'),originalIndex:1}],taxes:2.6,restockChoices:[{index:0,restock:false}]});
  assert.equal(saved.lines.length,1);assert.equal(saved.netSales,20);assert.equal(saved.cogs,5);assert.equal(saved.totalCollected,22.6);assert.equal(saved.inventoryEditLock,null);
  await state.handlers.remove(id,{expectedUpdatedAt:saved.updatedAt.toISOString(),restockChoices:[{index:0,restock:true}]});
  assert.deepEqual(state.adjustments,[[],[{variantId:'B',soldDelta:-1}]]);
});

test('add a product to an existing sale and retain its name, payment status and original costs',async()=>{
  const state=setup([line('A')],{paymentStatus:'paid'});
  const saved=await state.handlers.update(id,{expectedUpdatedAt:stamp,lines:[{...line('A'),originalIndex:0},line('B',2)],taxes:7.8,restockChoices:[]});
  assert.equal(saved.orderNumber,'MAN-1');assert.equal(saved.paymentStatus,'paid');assert.equal(saved.lines.length,2);assert.equal(saved.netSales,60);assert.equal(saved.cogs,15);assert.equal(saved.totalCollected,67.8);
  assert.deepEqual(state.adjustments,[[{variantId:'B',soldDelta:2}]]);
});

test('existing rows keep historical costs even when catalog costs changed or the product disappeared',async t=>{
  const variant='gid://shopify/ProductVariant/1',newVariant='gid://shopify/ProductVariant/2';
  const state=setup([line(variant)]);
  t.mock.method(Catalog,'find',filter=>{
    assert.deepEqual(filter.variantId.$in,[newVariant]);
    return {lean:async()=>[{variantId:newVariant,title:'New catalog item',unitCost:8,productId:'product',sku:'NEW'}]};
  });
  const handlers=createManualSaleHandlers({Order:state.Order,shop:()=> 'test.myshopify.com',adjust:state.adjust});
  const saved=await handlers.update(id,{expectedUpdatedAt:stamp,lines:[{...line(variant),originalIndex:0,unitCost:999},line(newVariant)],restockChoices:[]});
  assert.equal(saved.lines[0].unitCost,5);assert.equal(saved.lines[0].costSource,'order-edit');assert.equal(saved.lines[1].unitCost,8);assert.equal(saved.cogs,13);
});

test('stale, already locked and simultaneous requests cannot change inventory twice',async()=>{
  const state=setup([line('A')]);
  await assert.rejects(state.handlers.remove(id,{expectedUpdatedAt:'2026-10-18T13:00:00Z',restockChoices:[{index:0,restock:true}]}),/changed/);
  assert.equal(state.adjustments.length,0);
  const body={expectedUpdatedAt:stamp,restockChoices:[{index:0,restock:true}]};
  const results=await Promise.allSettled([state.handlers.remove(id,body),state.handlers.remove(id,body)]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(state.adjustments.length,1);
  const locked=setup([line('A')],{inventoryEditLock:'existing-lock'});
  await assert.rejects(locked.handlers.remove(id,body),/being saved/);assert.equal(locked.adjustments.length,0);
});

test('a failed sale save reverses stock adjustments and leaves the original sale intact',async()=>{
  const state=setup([line('A'),line('B')]);state.failCommit=true;
  await assert.rejects(state.handlers.update(id,{expectedUpdatedAt:stamp,lines:[{...line('B'),originalIndex:1}],restockChoices:[{index:0,restock:true}]}),/Database save failed/);
  assert.deepEqual(state.adjustments,[[{variantId:'A',soldDelta:-1}],[{variantId:'A',soldDelta:1}]]);
  assert.equal(state.record.lines.length,2);assert.equal(state.record.inventoryEditLock,null);
});

test('inventory rejection keeps the sale; an uncertain write stays locked for reconciliation',async()=>{
  for(const uncertain of [false,true]){
    const state=setup([line('A')]);
    const handlers=createManualSaleHandlers({Order:state.Order,shop:()=> 'test.myshopify.com',hydrate:state.hydrate,adjust:async()=>{throw Object.assign(new Error('Inventory not confirmed'),{inventoryUncertain:uncertain});}});
    await assert.rejects(handlers.remove(id,{expectedUpdatedAt:stamp,restockChoices:[{index:0,restock:true}]}),/Inventory not confirmed/);
    assert.equal(state.record.lines.length,1);assert.equal(Boolean(state.record.inventoryEditLock),uncertain);
  }
});
