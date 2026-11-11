import crypto from 'crypto';
import {historicalLineCost} from './ledger.js';
import {Order,Cost,Session} from './models.js';
const apiVersion=()=>process.env.SHOPIFY_API_VERSION||'2026-10';
export const normalizeShop=s=>{const v=String(s||'').trim().toLowerCase().replace(/^https?:\/\//,'').replace(/\/$/,'');return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(v)?v:null};
export function verifyHmac(query){const {hmac,...rest}=query;const msg=Object.keys(rest).sort().map(k=>`${k}=${Array.isArray(rest[k])?rest[k].join(','):rest[k]}`).join('&');const digest=crypto.createHmac('sha256',process.env.SHOPIFY_CLIENT_SECRET).update(msg).digest('hex');return typeof hmac==='string'&&Buffer.byteLength(digest)===Buffer.byteLength(hmac)&&crypto.timingSafeEqual(Buffer.from(digest),Buffer.from(hmac));}
export async function tokenFor(shop){const s=await Session.findOne({shop});if(!s)throw new Error('Store is not connected');return s.accessToken;}
export async function gql(shop,query,variables={}){const token=await tokenFor(shop);const r=await fetch(`https://${shop}/admin/api/${apiVersion()}/graphql.json`,{method:'POST',headers:{'Content-Type':'application/json','X-Shopify-Access-Token':token},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(60000)});if(!r.ok)throw new Error(`Shopify ${r.status}: ${await r.text()}`);const j=await r.json();if(j.errors)throw new Error(j.errors.map(x=>x.message).join('; '));return j.data;}
const money=v=>Number(v?.amount||0);
async function costFor(line,date){const variantId=line.variant?.id||'';const sku=line.sku||line.variant?.sku||'';const keys=[...(variantId?[{variantId}]:[]),...(sku?[{sku}]:[])];return keys.length?Cost.findOne({$or:keys,effectiveFrom:{$lte:date}}).sort({effectiveFrom:-1}):null;}
export async function persistOrder(node,attempt=0){
  const existing=await Order.findOne({shopifyId:node.id}).lean();
  const created=new Date(node.createdAt),lines=[];
  for(const edge of node.lineItems.edges){
    const l=edge.node,c=await costFor(l,created);
    const qty=Math.max(0,l.currentQuantity??l.quantity??0);
    const gross=money(l.originalTotalSet?.shopMoney),discount=money(l.totalDiscountSet?.shopMoney);
    const {unitCost,costSource}=historicalLineCost(existing,l.id,c?.unitCost??money(l.variant?.inventoryItem?.unitCost),c?'override':'shopify');
    lines.push({shopifyLineId:l.id,productId:l.product?.id,variantId:l.variant?.id,title:l.title,variantTitle:l.variantTitle,sku:l.sku||l.variant?.sku,quantity:qty,gross,discount,net:gross-discount,unitCost,cogs:unitCost*qty,costSource});
  }
  // Shopify's current subtotal already reflects returned/refunded products.
  // Never subtract totalRefundedSet (which also includes tax and freight) again.
  const net=Math.max(0,money(node.currentSubtotalPriceSet?.shopMoney));
  const beforeReturns=money(node.subtotalPriceSet?.shopMoney);
  const returns=Math.max(0,beforeReturns-net);
  const discounts=money((node.currentTotalDiscountsSet||node.totalDiscountsSet)?.shopMoney);
  const values={
    orderNumber:String(node.legacyResourceId||node.name),name:node.name,source:'shopify',
    createdAtShopify:created,currency:node.currencyCode,
    financialStatus:node.displayFinancialStatus,fulfillmentStatus:node.displayFulfillmentStatus,
    grossSales:net+returns+discounts,discounts,returns,netSales:net,
    shippingRevenue:money((node.currentShippingPriceSet||node.totalShippingPriceSet)?.shopMoney),
    taxes:money(node.currentTotalTaxSet?.shopMoney),
    totalCollected:money(node.currentTotalPriceSet?.shopMoney),
    discountCodes:Array.isArray(node.discountCodes)?node.discountCodes:[],
    cogs:lines.reduce((sum,line)=>sum+line.cogs,0),lines,raw:node,lastSyncedAt:new Date()
  };
  const saved=await Order.findOneAndUpdate(
    {shopifyId:node.id,...(existing?{updatedAt:existing.updatedAt}:{})},
    {$set:values},{upsert:!existing,new:true,runValidators:true}
  );
  if(!saved){if(attempt<3)return persistOrder(node,attempt+1);throw new Error('Order changed during sync; retry the sync.');}
  return saved;
}
const ORDER_FIELDS=`id legacyResourceId name createdAt updatedAt currencyCode discountCodes displayFinancialStatus displayFulfillmentStatus subtotalPriceSet{shopMoney{amount}} currentSubtotalPriceSet{shopMoney{amount currencyCode}} currentTotalDiscountsSet{shopMoney{amount}} currentShippingPriceSet{shopMoney{amount}} currentTotalTaxSet{shopMoney{amount}} currentTotalPriceSet{shopMoney{amount}} lineItems(first:100){edges{node{id title variantTitle sku quantity currentQuantity originalTotalSet{shopMoney{amount}} totalDiscountSet{shopMoney{amount}} product{id} variant{id sku inventoryItem{unitCost{amount currencyCode}}}}}}`;
export async function syncOrders(shop,{updatedSince=null,onPage=()=>{}}={}){
  let after=null,count=0,pages=0;
  const query=updatedSince?`updated_at:>=${new Date(updatedSince).toISOString()}`:null;
  do{
    const d=await gql(shop,`query($after:String,$query:String){orders(first:100,after:$after,sortKey:UPDATED_AT,query:$query){pageInfo{hasNextPage endCursor}edges{node{${ORDER_FIELDS}}}}}`,{after,query});
    for(const e of d.orders.edges){await persistOrder(e.node);count++;}
    pages++;
    await onPage({count,pages});
    if(d.orders.pageInfo.hasNextPage&&!d.orders.pageInfo.endCursor)throw new Error('Shopify did not supply the next order cursor');
    after=d.orders.pageInfo.hasNextPage?d.orders.pageInfo.endCursor:null;
  }while(after);
  return count;
}
export function verifyWebhook(raw,hmac){const digest=crypto.createHmac('sha256',process.env.SHOPIFY_CLIENT_SECRET).update(raw).digest('base64');return hmac&&crypto.timingSafeEqual(Buffer.from(digest),Buffer.from(hmac));}
export {ORDER_FIELDS};
