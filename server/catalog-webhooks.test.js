import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {CATALOG_TOPICS, LIST_WEBHOOKS, CREATE_WEBHOOK, UPDATE_WEBHOOK, validWebhook, webhookResource, createCatalogWebhooks} from './catalog-webhooks.js';

const shop='test.myshopify.com',productId='gid://shopify/Product/123',inventoryItemId='gid://shopify/InventoryItem/456';
const uri='https://example.com/webhooks/catalog';
test('webhook signatures cover exact raw bytes and reject missing or malformed signatures',()=>{
  const raw=Buffer.from('{"id":123}'),secret='test-secret';
  const signature=crypto.createHmac('sha256',secret).update(raw).digest('base64');
  assert.equal(validWebhook(raw,signature,secret),true);
  assert.equal(validWebhook(Buffer.from('{"id":124}'),signature,secret),false);
  assert.equal(validWebhook(raw,'bad',secret),false);
  assert.equal(validWebhook(raw,null,secret),false);
  assert.equal(validWebhook({},signature,secret),false);
});
test('all nine subscribed topics resolve the right product or inventory item',()=>{
  for(const topic of Object.keys(CATALOG_TOPICS)){
    const isProduct=topic.startsWith('products/');
    const payload=topic.startsWith('inventory_levels/')?{inventory_item_id:456}:{admin_graphql_api_id:isProduct?productId:inventoryItemId};
    assert.deepEqual(webhookResource(topic,payload),{resourceType:isProduct?'product':'inventoryItem',resourceId:isProduct?productId:inventoryItemId});
  }
  assert.throws(()=>webhookResource('orders/create',{id:1}));
  assert.throws(()=>webhookResource('products/create',{id:'invalid'}));
  assert.throws(()=>webhookResource('products/create',{id:Number.MAX_SAFE_INTEGER+1}));
});
function fixture(options={}){
  const subscriptions=options.subscriptions||[],calls=[],statuses=[],writes=[],refreshes=[],fullScans=[];
  const syncCatalog=async(...args)=>{fullScans.push(args);};
  syncCatalog.refreshProduct=async(...args)=>{refreshes.push(args);if(options.refreshError)throw new Error('Shopify offline');};
  const service=createCatalogWebhooks({appUrl:'https://example.com',syncCatalog,
    gql:async(s,query,variables)=>{
      calls.push({query,variables});
      if(query===LIST_WEBHOOKS)return {webhookSubscriptions:{nodes:subscriptions,pageInfo:{hasNextPage:false}}};
      if(query===CREATE_WEBHOOK){
        if(options.registrationError)return {webhookSubscriptionCreate:{userErrors:[{message:'Access denied'}],webhookSubscription:null}};
        const item={id:`hook-${subscriptions.length}`,topic:variables.topic,uri:variables.input.uri,format:'JSON',filter:null,includeFields:[]};
        subscriptions.push(item);return {webhookSubscriptionCreate:{userErrors:[],webhookSubscription:item}};
      }
      if(query===UPDATE_WEBHOOK){const item=subscriptions.find(item=>item.id===variables.id);Object.assign(item,{...variables.input,includeFields:[]});return {webhookSubscriptionUpdate:{userErrors:[],webhookSubscription:item}};}
      throw new Error('Unexpected operation');
    },
    Setting:{findOneAndUpdate:async(...args)=>statuses.push(args)},
    Catalog:{findOne:()=>({select:()=>({lean:async()=>options.unknownInventory?null:{productId}})})},
    WebhookJob:{updateOne:async(...args)=>{writes.push(args);if(options.queueError)throw Object.assign(new Error('Database unavailable'),{code:options.queueError});}}
  });
  return {service,calls,statuses,writes,refreshes,fullScans,subscriptions};
}
test('registration creates missing subscriptions once and preserves unrelated destinations',async()=>{
  const other={id:'other',topic:'PRODUCTS_UPDATE',uri:'https://other.example/hooks',format:'JSON',includeFields:[]};
  const h=fixture({subscriptions:[other]});
  const result=await h.service.ensure(shop);
  assert.equal(result.active,true);assert.equal(result.registered,9);
  await h.service.ensure(shop);
  assert.equal(h.calls.filter(call=>call.query===CREATE_WEBHOOK).length,9);
  assert.ok(h.subscriptions.includes(other));
});
test('filtered subscriptions at this endpoint are repaired instead of treated as healthy',async()=>{
  const subscriptions=Object.values(CATALOG_TOPICS).map((topic,i)=>({id:`hook-${i}`,topic,uri,format:'JSON',filter:i===0?'id:123':null,includeFields:[]}));
  const h=fixture({subscriptions});
  assert.equal((await h.service.ensure(shop)).active,true);
  assert.equal(h.calls.filter(call=>call.query===UPDATE_WEBHOOK).length,1);
});
test('registration failures are visible and never reported as active',async()=>{
  const h=fixture({registrationError:true});
  const result=await h.service.ensure(shop);
  assert.equal(result.active,false);assert.equal(result.registered,0);assert.match(result.error,/Access denied/);
});
test('delivery persistence uses insert-only upsert with an idempotency key',async()=>{
  const h=fixture();
  await h.service.receive(shop,'products/update','delivery-1',{id:123});
  const [filter,update,options]=h.writes[0];
  assert.deepEqual(filter,{shop,deliveryId:'delivery-1'});
  assert.equal(update.$setOnInsert.resourceId,productId);
  assert.equal(update.$setOnInsert.status,'pending');assert.equal(update.$set,undefined);
  assert.equal(options.upsert,true);
});
test('database failures propagate for Shopify retries; duplicate delivery races are accepted',async()=>{
  await assert.rejects(fixture({queueError:89}).service.receive(shop,'products/update','delivery-1',{id:123}),/Database unavailable/);
  await fixture({queueError:11000}).service.receive(shop,'products/update','delivery-1',{id:123});
});
const job={_id:'job-1',shop,resourceType:'product',resourceId:productId,attempts:1,receivedAt:new Date()};
test('product events refresh current Shopify state, even for delete notifications',async()=>{
  const h=fixture();assert.equal(await h.service.process({...job,topic:'products/delete'}),true);
  assert.deepEqual(h.refreshes,[[shop,productId]]);assert.equal(h.fullScans.length,0);
  assert.equal(h.writes[0][1].$set.status,'done');assert.ok(h.writes[0][1].$set.expiresAt);
});
test('inventory events find the affected product; unknown new items use a full recovery scan',async()=>{
  const h=fixture();await h.service.process({...job,resourceType:'inventoryItem',resourceId:inventoryItemId});
  assert.deepEqual(h.refreshes,[[shop,productId]]);
  const unknown=fixture({unknownInventory:true});await unknown.service.process({...job,resourceType:'inventoryItem',resourceId:inventoryItemId});
  assert.deepEqual(unknown.fullScans,[[shop,{fresh:true}]]);
});
test('failed processing remains queued for retry instead of dropping the event',async()=>{
  const h=fixture({refreshError:true});assert.equal(await h.service.process(job),false);
  assert.equal(h.writes[0][1].$set.status,'pending');assert.ok(h.writes[0][1].$set.nextAttemptAt>new Date());
  assert.equal(h.writes[0][1].$set.expiresAt,undefined);
  assert.match(h.statuses[0][1].$set['value.processingError'],/Shopify offline/);
});
