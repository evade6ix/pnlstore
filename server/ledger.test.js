import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createLedgerRouter,ledgerValues,ledgerDate,manualSaleValues,orderCostValues,orderPaymentValues,historicalLineCost} from './ledger.js';
import {ownerToken} from './owner-auth.js';

const date=new Date('2026-10-10T00:00:00Z'),stamp=new Date('2026-10-15T12:00:00Z');
test('editing an expense preserves omitted fields and handles credits, zero tax and recurring labels',()=>{
  const current={date,vendor:'Supplier',category:'Software',amount:50,tax:6.5,notes:'Receipt retained',recurring:false};
  const set=ledgerValues('expenses',{amount:-10,tax:0,recurring:true,reference:'Credit-1'},current);
  assert.equal(set.amount,-10);assert.equal(set.tax,0);assert.equal(set.recurring,true);assert.equal(set.notes,undefined);
  assert.equal({...current,...set}.notes,'Receipt retained');
  assert.equal({...current,...set}.date,date);
});
test('PO editing retains one goods amount alongside shipping, duties and tax',()=>{
  const current={date,vendor:'Supplier',total:1000,shipping:40,duties:10,tax:50};
  const set=ledgerValues('purchases',{total:800,shipping:20,status:'received'},current);
  const saved={...current,...set};assert.equal(saved.subtotal,800);assert.equal(saved.total+saved.shipping+saved.duties+saved.tax,880);
});
test('cost overrides support exact variant IDs and reject missing identification',()=>{
  const set=ledgerValues('costs',{variantId:'gid://shopify/ProductVariant/123',sku:'',unitCost:0,effectiveFrom:'2026-10-01'});
  assert.equal(set.unitCost,0);assert.equal(set.effectiveFrom.toISOString(),'2026-10-01T00:00:00.000Z');
  assert.throws(()=>ledgerValues('costs',{sku:'',unitCost:10,effectiveFrom:'2026-10-01'}),/SKU or variant/);
});
test('invalid dates and nonfinite amounts are rejected before saving',()=>{
  for(const value of ['2026-02-30','2026-13-01','bad',''])assert.throws(()=>ledgerDate(value));
  for(const amount of [null,'',Infinity,NaN,'abc'])assert.throws(()=>ledgerValues('expenses',{date:'2026-10-01',vendor:'X',category:'Other',amount}));
});
test('manual sale edits recalculate line totals, COGS and collected amount',()=>{
  const result=manualSaleValues({name:'Event sale',date:'2026-10-14',shippingRevenue:10,taxes:13,shippingCost:7,paymentFees:3,materialCost:2,otherVariableCost:1,
    lines:[{title:'Combo',quantity:2,gross:100,discount:10,unitCost:20},{title:'Part',quantity:1,gross:15,unitCost:5}]});
  assert.equal(result.grossSales,115);assert.equal(result.discounts,10);assert.equal(result.netSales,105);assert.equal(result.cogs,45);assert.equal(result.totalCollected,128);
  assert.equal(result.createdAtShopify.toISOString(),'2026-10-14T12:00:00.000Z');
  assert.equal(result.netSales+result.shippingRevenue-result.cogs-result.shippingCost-result.paymentFees-result.materialCost-result.otherVariableCost,57);
});
test('manual sale edits reject invalid quantities, excessive discounts and Shopify source records',()=>{
  const body={name:'Test',date:'2026-10-14',lines:[{title:'Item',quantity:1,gross:10,discount:0,unitCost:5}]};
  assert.throws(()=>manualSaleValues(body,{source:'shopify'}),/Shopify/);
  assert.throws(()=>manualSaleValues({...body,lines:[]}),/at least one/);
  assert.throws(()=>manualSaleValues({...body,lines:[{...body.lines[0],quantity:0}]}));
  assert.throws(()=>manualSaleValues({...body,lines:[{...body.lines[0],quantity:1.5}]}));
  assert.throws(()=>manualSaleValues({...body,lines:[{...body.lines[0],discount:11}]}));
});
test('order cost edits preserve other imported fields and snapshot sources until a cost changes',()=>{
  const current={lines:[{shopifyLineId:'line-1',title:'Item',quantity:3,unitCost:5,cogs:15,costSource:'shopify'}]};
  assert.equal(orderCostValues(current,{lineCosts:[{index:0,unitCost:5}]}).lines[0].costSource,'shopify');
  const result=orderCostValues(current,{lineCosts:[{index:0,unitCost:4}],shippingCost:7,notes:'Corrected cost',netSales:9999});
  assert.equal(result.cogs,12);assert.equal(result.lines[0].costSource,'order-edit');assert.equal(result.netSales,undefined);
  assert.equal(result.lines[0].title,'Item');
  assert.deepEqual(historicalLineCost({lines:result.lines},'line-1',99,'shopify'),{unitCost:4,costSource:'order-edit'});
  assert.deepEqual(historicalLineCost({lines:[{shopifyLineId:'line-1',unitCost:0,costSource:'order-edit'}]},'line-1',99,'shopify'),{unitCost:0,costSource:'order-edit'});
});

function memoryModel(seed=[]){
  const records=seed.map(record=>({...record}));let counter=10;
  const match=(record,filter)=>Object.entries(filter).every(([key,value])=>value instanceof Date?new Date(record[key]).getTime()===value.getTime():value===null?record[key]==null:record[key]===value);
  return {records,
    find:()=>({sort:()=>({lean:async()=>records})}),
    findOne:filter=>({lean:async()=>records.find(record=>match(record,filter))||null}),
    create:async data=>{const record={...data,_id:String(counter++).padStart(24,'0'),createdAt:stamp,updatedAt:stamp};records.push(record);return record;},
    findOneAndUpdate:async(filter,update)=>{const record=records.find(record=>match(record,filter));if(!record)return null;Object.assign(record,update.$set,{updatedAt:new Date(stamp.getTime()+1000)});return record;},
    findOneAndDelete:async filter=>{const index=records.findIndex(record=>match(record,filter));return index<0?null:records.splice(index,1)[0];}
  };
}
test('ledger APIs save edits on the same record, reject stale edits and require the owner session',async t=>{
  const id='000000000000000000000001',shop='example.myshopify.com',secret='test-secret',origin='http://workspace.example';
  const Expense=memoryModel([{_id:id,date,vendor:'Original',category:'Software',amount:50,tax:0,updatedAt:stamp}]);
  const Order=memoryModel([{_id:id,source:'manual',orderNumber:'MAN-1',name:'Original sale',createdAtShopify:date,updatedAt:stamp,lines:[{title:'Item',quantity:1,gross:20,discount:0,net:20,unitCost:10,cogs:10}]}]);
  const app=express();app.use(express.json());app.use('/api',createLedgerRouter({Expense,Purchase:memoryModel(),Cost:memoryModel(),Order,shop:()=>shop,secret,appUrl:origin}));
  app.use((error,req,res,next)=>res.status(error.status||500).json({error:error.message}));
  const server=await new Promise(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});
  t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}`;
  const headers={'Content-Type':'application/json',Origin:origin,Cookie:`pnl_owner=${ownerToken(shop,secret)}`};
  const body={vendor:'Updated',amount:75,expectedUpdatedAt:stamp.toISOString(),source:'malicious'};
  const unauthorized=await fetch(`${base}/api/expenses/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(body)});assert.equal(unauthorized.status,401);
  const saved=await fetch(`${base}/api/expenses/${id}`,{method:'PATCH',headers,body:JSON.stringify(body)});assert.equal(saved.status,200);const record=await saved.json();
  assert.equal(record._id,id);assert.equal(record.amount,75);assert.equal(record.category,'Software');assert.equal(Expense.records.length,1);assert.equal(record.source,undefined);
  const stale=await fetch(`${base}/api/expenses/${id}`,{method:'PATCH',headers,body:JSON.stringify({...body,amount:999})});assert.equal(stale.status,409);assert.equal(Expense.records[0].amount,75);
  const crossOrigin=await fetch(`${base}/api/expenses/${id}`,{method:'PATCH',headers:{...headers,Origin:'http://elsewhere.example'},body:JSON.stringify(body)});assert.equal(crossOrigin.status,403);
  const sale=await fetch(`${base}/api/manual-sales/${id}`,{method:'PATCH',headers,body:JSON.stringify({expectedUpdatedAt:stamp.toISOString(),name:'Updated sale',date:'2026-10-12',lines:[{title:'New item',quantity:2,gross:40,discount:5,unitCost:10}],shippingRevenue:5,taxes:4})});assert.equal(sale.status,200);const saleRecord=await sale.json();assert.equal(saleRecord.orderNumber,'MAN-1');assert.equal(saleRecord.netSales,35);assert.equal(saleRecord.totalCollected,44);assert.equal(saleRecord.cogs,20);assert.equal(Order.records.length,1);
  const paymentBody={expectedUpdatedAt:saleRecord.updatedAt,paymentStatus:'unpaid'};
  const deniedPayment=await fetch(`${base}/api/orders/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(paymentBody)});assert.equal(deniedPayment.status,401);
  const invalidPayment=await fetch(`${base}/api/orders/${id}`,{method:'PATCH',headers,body:JSON.stringify({...paymentBody,paymentStatus:'invalid'})});assert.equal(invalidPayment.status,400);
  const paymentSave=await fetch(`${base}/api/orders/${id}`,{method:'PATCH',headers,body:JSON.stringify(paymentBody)});assert.equal(paymentSave.status,200);
  const paymentRecord=await paymentSave.json();assert.equal(paymentRecord.paymentStatus,'unpaid');assert.equal(paymentRecord.netSales,35);assert.equal(paymentRecord.cogs,20);assert.equal(paymentRecord.totalCollected,44);
});


test('payment changes validate independently and leave financial totals and imported status alone',()=>{
  assert.deepEqual(orderPaymentValues({paymentStatus:'paid'}),{paymentStatus:'paid'});
  assert.deepEqual(orderPaymentValues({paymentStatus:'unpaid'}),{paymentStatus:'unpaid'});
  assert.deepEqual(orderPaymentValues({paymentStatus:null}),{paymentStatus:null});
  assert.deepEqual(orderPaymentValues({}),{});
  for(const value of ['PAID','pending','',true,1,{},[]])assert.throws(()=>orderPaymentValues({paymentStatus:value}));
  assert.deepEqual(orderCostValues({lines:[]},{paymentStatus:'unpaid',financialStatus:'PAID',netSales:999}),{paymentStatus:'unpaid'});
  const body={name:'Event',date:'2026-10-19',paymentStatus:'unpaid',lines:[{title:'Item',quantity:1,gross:20,unitCost:10}]};
  assert.equal(manualSaleValues(body).paymentStatus,'unpaid');
  const {paymentStatus,...omitted}=body;
  assert.equal(manualSaleValues(omitted,{source:'manual',paymentStatus:'paid'}).paymentStatus,undefined);
});
