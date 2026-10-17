import express from 'express';
import crypto from 'node:crypto';
import {cookieValue,verifyOwnerToken} from './owner-auth.js';
import {Catalog} from './models.js';
import {gql} from './shopify.js';

export const ledgerError=(message,status=400)=>Object.assign(new Error(message),{status});
const own=(o,k)=>Object.hasOwn(o,k);
export const cash=n=>Math.round((n+Number.EPSILON)*100)/100;
function number(value,label,{min=-1e12,max=1e12}={}){
  if(!['number','string'].includes(typeof value)||String(value).trim()===''||!Number.isFinite(Number(value))||Number(value)<min||Number(value)>max)throw ledgerError(`${label} must be a valid number${min===0?' of zero or more':''}.`);
  return Number(value);
}
function text(value,label,required=false){
  if(typeof value!=='string'||value.length>10000)throw ledgerError(`${label} must be text.`);
  const result=value.trim();if(required&&!result)throw ledgerError(`${label} is required.`);return result;
}
export function ledgerDate(value,label='Date'){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw ledgerError(`${label} is required.`);
  const date=new Date(`${value}T00:00:00.000Z`);
  if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==value)throw ledgerError(`${label} is invalid.`);
  return date;
}
const specs={
  expenses:{date:'date',vendor:'text',category:'text',description:'text',amount:'number',tax:'number',reference:'text',notes:'text',recurring:'boolean'},
  purchases:{date:'date',vendor:'text',poNumber:'text',status:'text',total:'number',shipping:'number',duties:'number',tax:'number',notes:'text'},
  costs:{sku:'text',variantId:'text',title:'text',unitCost:'cost',effectiveFrom:'date',notes:'text'}
};
export function ledgerValues(kind,body,current={}){
  const spec=specs[kind];if(!spec||!body||typeof body!=='object')throw ledgerError('Invalid record.');
  const set={};
  for(const [key,type] of Object.entries(spec))if(own(body,key)){
    const value=body[key];
    if(type==='date')set[key]=ledgerDate(value,key==='effectiveFrom'?'Effective date':'Date');
    else if(type==='text')set[key]=text(value,key);
    else if(type==='boolean'){if(typeof value!=='boolean')throw ledgerError(`${key} must be true or false.`);set[key]=value;}
    else set[key]=number(value,key,type==='cost'?{min:0}:{});
  }
  const merged={...current,...set};
  if(kind==='costs'){
    if(!merged.sku&&!merged.variantId)throw ledgerError('A SKU or variant ID is required.');
    if(merged.variantId&&!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(merged.variantId))throw ledgerError('Variant ID must be a Shopify product variant ID.');
    if(merged.unitCost==null||!merged.effectiveFrom)throw ledgerError('Unit cost and effective date are required.');
  }else{
    if(!merged.date)throw ledgerError('Date is required.');
    if(!merged.vendor)throw ledgerError('Vendor is required.');
    if(kind==='expenses'&&!merged.category)throw ledgerError('Category is required.');
    if(merged[kind==='expenses'?'amount':'total']==null)throw ledgerError('Amount is required.');
  }
  if(kind==='purchases'&&own(set,'total'))set.subtotal=set.total;
  return set;
}
const COST_FIELDS=['shippingCost','paymentFees','materialCost','otherVariableCost'];
export function orderCostValues(current,body){
  const set={};
  for(const key of COST_FIELDS)if(own(body,key))set[key]=number(body[key],key);
  if(own(body,'notes'))set.notes=text(body.notes,'Notes');
  if(own(body,'lineCosts')){
    if(!Array.isArray(body.lineCosts)||body.lineCosts.length>1000)throw ledgerError('Invalid line costs.');
    const lines=current.lines.map(line=>({...line})),seen=new Set();
    for(const change of body.lineCosts){
      if(!Number.isInteger(change.index)||!lines[change.index]||seen.has(change.index))throw ledgerError('Invalid order line.');
      seen.add(change.index);const unitCost=number(change.unitCost,'Unit cost',{min:0});
      const line=lines[change.index];
      if(unitCost!==line.unitCost){line.unitCost=unitCost;line.cogs=cash(unitCost*line.quantity);line.costSource='order-edit';}
    }
    set.lines=lines;set.cogs=cash(lines.reduce((sum,line)=>sum+(line.cogs||0),0));
  }
  return set;
}
export function manualSaleValues(body,current={}){
  if(current.source&&current.source!=='manual')throw ledgerError('Shopify sale details must be edited in Shopify.',409);
  const set={source:'manual',currency:current.currency||'CAD'};
  set.name=own(body,'name')?text(body.name,'Sale name',true):current.name||'Manual sale';
  if(own(body,'date')){set.createdAtShopify=ledgerDate(body.date);set.createdAtShopify.setUTCHours(12);}
  else if(!current.createdAtShopify)throw ledgerError('Date is required.');
  if(!Array.isArray(body.lines)||!body.lines.length||body.lines.length>1000)throw ledgerError('Add at least one sale item.');
  set.lines=body.lines.map((line,index)=>{
    const quantity=number(line.quantity,'Quantity',{min:1,max:1000000});
    if(!Number.isInteger(quantity))throw ledgerError('Quantity must be a whole number.');
    const gross=number(line.gross,'Line sales',{min:0}),discount=number(line.discount??0,'Line discount',{min:0,max:gross}),unitCost=number(line.unitCost??0,'Unit cost',{min:0});
    const variantId=text(line.variantId||'','Variant ID'),productId=text(line.productId||'','Product ID');
    return {productId,variantId,title:text(line.title,`Item ${index+1} title`,true),variantTitle:text(line.variantTitle||'','Variant'),sku:text(line.sku||'','SKU'),quantity,gross:cash(gross),discount:cash(discount),net:cash(gross-discount),unitCost,cogs:cash(unitCost*quantity),costSource:variantId?'catalog':'manual'};
  });
  for(const key of [...COST_FIELDS,'shippingRevenue','taxes'])set[key]=own(body,key)?number(body[key],key,COST_FIELDS.includes(key)?{}:{min:0}):current[key]||0;
  set.notes=own(body,'notes')?text(body.notes,'Notes'):current.notes||'';
  set.grossSales=cash(set.lines.reduce((sum,line)=>sum+line.gross,0));
  set.discounts=cash(set.lines.reduce((sum,line)=>sum+line.discount,0));
  set.netSales=cash(set.lines.reduce((sum,line)=>sum+line.net,0));
  set.cogs=cash(set.lines.reduce((sum,line)=>sum+line.cogs,0));
  set.totalCollected=cash(set.netSales+set.shippingRevenue+set.taxes);
  return set;
}

async function hydrateCatalogLines(body,shopName){
  if(!Array.isArray(body?.lines))return body;
  const ids=[...new Set(body.lines.map(line=>line?.variantId).filter(Boolean))];
  if(!ids.length)return body;
  if(ids.some(id=>!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(id)))throw ledgerError('Invalid Shopify variant selected.');
  const records=await Catalog.find({shop:shopName,variantId:{$in:ids}}).lean();
  const byId=new Map(records.map(record=>[record.variantId,record]));
  const lines=body.lines.map((line,index)=>{
    if(!line.variantId)return line;
    const item=byId.get(line.variantId);
    if(!item)throw ledgerError(`Item ${index+1} is no longer in the Shopify catalog. Refresh products and choose it again.`,409);
    return {...line,productId:item.productId,title:item.title,variantTitle:item.variantTitle,sku:item.sku||'',unitCost:item.unitCost??0};
  });
  return {...body,lines};
}

const INVENTORY_LEVEL_QUERY=`query ManualSaleInventory($id: ID!) {
  inventoryItem(id: $id) { id tracked inventoryLevels(first: 100) { nodes { location { id name isActive } quantities(names:["available"]) { name quantity } } } }
}`;
const INVENTORY_ADJUST_MUTATION=`mutation ManualSaleAdjustInventory($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
  inventoryAdjustQuantities(input:$input) @idempotent(key:$idempotencyKey) { inventoryAdjustmentGroup { createdAt reason changes { name delta } } userErrors { field message } }
}`;
function variantQuantities(lines=[]){
  const result=new Map();
  for(const line of lines)if(line.variantId)result.set(line.variantId,(result.get(line.variantId)||0)+Number(line.quantity||0));
  return result;
}
function saleInventoryDeltas(previousLines,nextLines){
  const before=variantQuantities(previousLines),after=variantQuantities(nextLines),ids=new Set([...before.keys(),...after.keys()]);
  return [...ids].map(variantId=>({variantId,soldDelta:(after.get(variantId)||0)-(before.get(variantId)||0)})).filter(item=>item.soldDelta!==0);
}
async function adjustVariantInventory(shopName,variantId,soldDelta){
  const record=await Catalog.findOne({shop:shopName,variantId}).lean();
  if(!record)throw ledgerError('A selected Shopify item is no longer available. Refresh products and try again.',409);
  if(!record.tracked||!record.inventoryItemId)throw ledgerError(`${record.title}${record.variantTitle&&record.variantTitle!=='Default Title'?` - ${record.variantTitle}`:''} is not tracking inventory in Shopify.`,409);
  const data=await gql(shopName,INVENTORY_LEVEL_QUERY,{id:record.inventoryItemId});
  const item=data.inventoryItem;
  if(!item?.tracked)throw ledgerError(`${record.title} is not tracking inventory in Shopify.`,409);
  const levels=(item.inventoryLevels?.nodes||[]).filter(level=>level.location?.isActive);
  if(!levels.length)throw ledgerError(`${record.title} has no active Shopify inventory location.`,409);
  const changes=[];
  if(soldDelta>0){
    let need=soldDelta;
    for(const level of levels){
      if(need<=0)break;
      const available=Number(level.quantities?.find(q=>q.name==='available')?.quantity||0);
      const take=Math.min(Math.max(0,available),need);
      if(take>0){changes.push({delta:-take,inventoryItemId:record.inventoryItemId,locationId:level.location.id});need-=take;}
    }
    if(need>0)changes.push({delta:-need,inventoryItemId:record.inventoryItemId,locationId:levels[0].location.id});
  }else if(soldDelta<0){
    changes.push({delta:-soldDelta,inventoryItemId:record.inventoryItemId,locationId:levels[0].location.id});
  }
  if(!changes.length)return;
  let result;
  try{result=await gql(shopName,INVENTORY_ADJUST_MUTATION,{input:{name:'available',reason:'correction',referenceDocumentUri:`gid://pnlstore/ManualSaleAdjustment/${crypto.randomUUID()}`,changes},idempotencyKey:crypto.randomUUID()});}
  catch(error){throw ledgerError(`Shopify could not confirm the inventory change for ${record.title}: ${error.message}`,502);}
  const errors=result.inventoryAdjustQuantities?.userErrors||[];
  if(errors.length)throw ledgerError(errors.map(error=>error.message).join('; '),409);
  await Catalog.updateOne({shop:shopName,variantId},{$inc:{quantity:-soldDelta}});
}
async function applyInventoryDeltas(shopName,deltas){
  const applied=[];
  try{
    for(const delta of deltas){await adjustVariantInventory(shopName,delta.variantId,delta.soldDelta);applied.push(delta);}
  }catch(error){
    for(const delta of applied.reverse())try{await adjustVariantInventory(shopName,delta.variantId,-delta.soldDelta);}catch(rollbackError){console.error('Manual sale inventory rollback:',rollbackError.message);}
    throw error;
  }
}

export async function updateLedgerRecord(Model,id,body,build,{source}={}){
  if(!/^[a-f\d]{24}$/i.test(id))throw ledgerError('Record not found.',404);
  const filter={_id:id,...(source?{source}:{})};
  const current=await Model.findOne(filter).lean();if(!current)throw ledgerError('Record not found.',404);
  if(typeof body.expectedUpdatedAt!=='string'||!Number.isFinite(Date.parse(body.expectedUpdatedAt)))throw ledgerError('Reload this record before saving.');
  const set=build(current,body);
  const result=await Model.findOneAndUpdate({...filter,updatedAt:new Date(body.expectedUpdatedAt)},{$set:set},{new:true,runValidators:true});
  if(!result)throw ledgerError('This record changed since you opened it. Reload it before saving.',409);
  return result;
}
export function createLedgerRouter({Order,Expense,Purchase,Cost,shop,secret,appUrl}){
  const router=express.Router(),wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
  router.use((req,res,next)=>{
    if(!['POST','PATCH','DELETE'].includes(req.method)||!/^\/(expenses|purchases|costs|manual-sales|orders)(\/|$)/.test(req.path))return next();
    if(!verifyOwnerToken(cookieValue(req,'pnl_owner'),shop(),secret))return res.status(401).json({error:'Sign in through Shopify to change financial records.',authUrl:`/auth?shop=${shop()}`});
    if(req.get('origin')!==new URL(appUrl).origin||!req.is('application/json'))return res.status(403).json({error:'Save financial records from this workspace only.'});
    next();
  });
  for(const [kind,Model,sort] of [['expenses',Expense,{date:-1}],['purchases',Purchase,{date:-1}],['costs',Cost,{effectiveFrom:-1}]]){
    router.get(`/${kind}`,wrap(async(req,res)=>res.json(await Model.find().sort(sort).lean())));
    router.post(`/${kind}`,wrap(async(req,res)=>res.status(201).json(await Model.create(ledgerValues(kind,req.body)))));
    router.patch(`/${kind}/:id`,wrap(async(req,res)=>res.json(await updateLedgerRecord(Model,req.params.id,req.body,(current,body)=>ledgerValues(kind,body,current)))));
    router.delete(`/${kind}/:id`,wrap(async(req,res)=>{
      const expected=req.body?.expectedUpdatedAt;
      if(!expected||!Number.isFinite(Date.parse(expected)))throw ledgerError('Reload this record before deleting.');
      const deleted=await Model.findOneAndDelete({_id:req.params.id,updatedAt:new Date(expected)});
      if(!deleted)throw ledgerError('The record changed or was already removed. Reload the list.',409);
      res.sendStatus(204);
    }));
  }
  router.patch('/orders/:id',wrap(async(req,res)=>res.json(await updateLedgerRecord(Order,req.params.id,req.body,orderCostValues))));
  router.post('/manual-sales',wrap(async(req,res)=>{
    const hydrated=await hydrateCatalogLines(req.body,shop());
    const values=manualSaleValues(hydrated),deltas=saleInventoryDeltas([],values.lines);
    await applyInventoryDeltas(shop(),deltas);
    try{return res.status(201).json(await Order.create({...values,orderNumber:`MAN-${Date.now()}`}));}
    catch(error){await applyInventoryDeltas(shop(),deltas.map(delta=>({...delta,soldDelta:-delta.soldDelta}))).catch(rollbackError=>console.error('Manual sale create rollback:',rollbackError.message));throw error;}
  }));
  router.patch('/manual-sales/:id',wrap(async(req,res)=>{
    if(!/^[a-f\d]{24}$/i.test(req.params.id))throw ledgerError('Record not found.',404);
    const current=await Order.findOne({_id:req.params.id,source:'manual'}).lean();if(!current)throw ledgerError('Record not found.',404);
    if(typeof req.body.expectedUpdatedAt!=='string'||!Number.isFinite(Date.parse(req.body.expectedUpdatedAt)))throw ledgerError('Reload this record before saving.');
    const hydrated=await hydrateCatalogLines(req.body,shop()),set=manualSaleValues(hydrated,current),deltas=saleInventoryDeltas(current.lines,set.lines);
    await applyInventoryDeltas(shop(),deltas);
    try{
      const result=await Order.findOneAndUpdate({_id:req.params.id,source:'manual',updatedAt:new Date(req.body.expectedUpdatedAt)},{$set:set},{new:true,runValidators:true});
      if(!result)throw ledgerError('This record changed since you opened it. Reload it before saving.',409);
      return res.json(result);
    }catch(error){await applyInventoryDeltas(shop(),deltas.map(delta=>({...delta,soldDelta:-delta.soldDelta}))).catch(rollbackError=>console.error('Manual sale edit rollback:',rollbackError.message));throw error;}
  }));
  return router;
}

export function historicalLineCost(existing,lineId,fallback,source){
  const previous=existing?.lines?.find(line=>line.shopifyLineId===lineId);
  return previous&&Number.isFinite(previous.unitCost)?{unitCost:previous.unitCost,costSource:previous.costSource||'snapshot'}:{unitCost:fallback,costSource:source};
}
