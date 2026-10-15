import crypto from 'node:crypto';

export const CATALOG_TOPICS = {
  'products/create':'PRODUCTS_CREATE', 'products/update':'PRODUCTS_UPDATE', 'products/delete':'PRODUCTS_DELETE',
  'inventory_items/create':'INVENTORY_ITEMS_CREATE', 'inventory_items/update':'INVENTORY_ITEMS_UPDATE', 'inventory_items/delete':'INVENTORY_ITEMS_DELETE',
  'inventory_levels/update':'INVENTORY_LEVELS_UPDATE', 'inventory_levels/connect':'INVENTORY_LEVELS_CONNECT', 'inventory_levels/disconnect':'INVENTORY_LEVELS_DISCONNECT'
};
export const LIST_WEBHOOKS = `query CatalogWebhooks($after: String, $topics: [WebhookSubscriptionTopic!]) {
  webhookSubscriptions(first: 100, after: $after, topics: $topics) {
    pageInfo { hasNextPage endCursor }
    nodes { id topic uri format filter includeFields }
  }
}`;
export const CREATE_WEBHOOK = `mutation CreateCatalogWebhook($topic: WebhookSubscriptionTopic!, $input: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $input) {
    webhookSubscription { id topic uri format }
    userErrors { field message }
  }
}`;
export const UPDATE_WEBHOOK = `mutation UpdateCatalogWebhook($id: ID!, $input: WebhookSubscriptionInput!) {
  webhookSubscriptionUpdate(id: $id, webhookSubscription: $input) {
    webhookSubscription { id topic uri format }
    userErrors { field message }
  }
}`;

export function validWebhook(raw, hmac, secret) {
  if (!Buffer.isBuffer(raw) || typeof hmac !== 'string' || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('base64');
  return Buffer.byteLength(expected) === Buffer.byteLength(hmac) && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hmac));
}
function gid(type, value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('Unsafe webhook resource ID');
  const text = String(value ?? '');
  if (new RegExp(`^gid://shopify/${type}/\\d+$`).test(text)) return text;
  if (/^\d+$/.test(text)) return `gid://shopify/${type}/${text}`;
  throw new Error('Invalid webhook resource ID');
}
export function webhookResource(topic, payload) {
  if (!Object.hasOwn(CATALOG_TOPICS, topic)) throw new Error('Unsupported catalog topic');
  if (topic.startsWith('products/')) return {resourceType:'product',resourceId:gid('Product',payload.admin_graphql_api_id || payload.id)};
  return {resourceType:'inventoryItem',resourceId:gid('InventoryItem',topic.startsWith('inventory_levels/') ? payload.inventory_item_id : payload.admin_graphql_api_id || payload.id)};
}

export function createCatalogWebhooks({gql, Catalog, Setting, WebhookJob, syncCatalog, appUrl}) {
  const registration = new Map();
  const key = shop => `catalogWebhooks:${shop}`;
  const status = (shop, fields) => Setting.findOneAndUpdate({key:key(shop)}, {$set:Object.fromEntries(Object.entries(fields).map(([field,value]) => [`value.${field}`,value]))}, {upsert:true});
  async function list(shop) {
    let after = null, subscriptions = [];
    do {
      const data = await gql(shop, LIST_WEBHOOKS, {after,topics:Object.values(CATALOG_TOPICS)});
      const connection = data.webhookSubscriptions;
      subscriptions.push(...connection.nodes);
      if (connection.pageInfo.hasNextPage && (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === after)) throw new Error('Invalid webhook pagination');
      after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    } while (after);
    return subscriptions;
  }
  function ensure(shop) {
    if (registration.has(shop)) return registration.get(shop);
    const task = (async () => {
      try {
        const url = new URL('/webhooks/catalog', appUrl);
        if (url.protocol !== 'https:') throw new Error('Shopify webhooks require an HTTPS application URL');
        const uri = url.href, topics = Object.values(CATALOG_TOPICS);
        const existing = await list(shop), errors = [];
        for (const topic of topics) {
          const match = existing.find(subscription => subscription.topic === topic && subscription.uri === uri);
          if (match && match.format === 'JSON' && !match.filter && !match.includeFields?.length) continue;
          try {
            const data = await gql(shop, match ? UPDATE_WEBHOOK : CREATE_WEBHOOK, match ?
              {id:match.id,input:{uri,format:'JSON',filter:null,includeFields:null}} : {topic,input:{uri,format:'JSON'}});
            const result = match ? data.webhookSubscriptionUpdate : data.webhookSubscriptionCreate;
            if (result.userErrors.length) throw new Error(result.userErrors.map(error => error.message).join('; '));
            if (!result.webhookSubscription?.id) throw new Error('Shopify did not confirm the subscription');
          } catch (error) {errors.push(`${topic}: ${error.message}`);}
        }
        const verified = (await list(shop)).filter(subscription => subscription.uri === uri && subscription.format === 'JSON' && !subscription.filter && !subscription.includeFields?.length);
        const activeTopics = new Set(verified.map(subscription => subscription.topic));
        const active = topics.every(topic => activeTopics.has(topic));
        if (!active && !errors.length) errors.push('Some catalog webhooks are missing from Shopify');
        const result = {active,registered:topics.filter(topic => activeTopics.has(topic)).length,expected:topics.length,
          subscriptions:verified.map(({id,topic}) => ({id,topic})),checkedAt:new Date(),error:errors.join('; ') || null};
        await status(shop,result);
        return result;
      } catch (error) {
        await status(shop,{active:false,checkedAt:new Date(),error:error.message});
        throw error;
      }
    })().finally(() => registration.delete(shop));
    registration.set(shop,task);
    return task;
  }
  async function receive(shop, topic, deliveryId, payload) {
    if (typeof deliveryId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(deliveryId)) throw Object.assign(new Error('Invalid webhook delivery ID'),{status:400});
    let resource;
    try {resource = webhookResource(topic,payload);} catch(error) {throw Object.assign(error,{status:400});}
    const now = new Date();
    try {
      // Acknowledge only after MongoDB has saved the event. The unique index
      // deduplicates Shopify retries without losing work during restarts.
      await WebhookJob.updateOne({shop,deliveryId}, {$setOnInsert:{shop,deliveryId,topic,...resource,status:'pending',attempts:0,
        receivedAt:now,nextAttemptAt:new Date(now.getTime()+1500)}}, {upsert:true});
    } catch(error) {if (error.code !== 11000) throw error;}
  }
  async function process(job) {
    try {
      let productId = job.resourceId;
      if (job.resourceType === 'inventoryItem') {
        const record = await Catalog.findOne({shop:job.shop,inventoryItemId:job.resourceId}).select('productId').lean();
        productId = record?.productId;
      }
      // Re-fetch current state instead of trusting event order or truncated
      // product payloads. Unknown new inventory items get a recovery full scan.
      if (productId) await syncCatalog.refreshProduct(job.shop,productId);
      else await syncCatalog(job.shop,{fresh:true});
      const now = new Date();
      await WebhookJob.updateOne({_id:job._id}, {$set:{status:'done',processedAt:now,error:null,
        expiresAt:new Date(now.getTime()+7*24*60*60*1000)},$unset:{lockedUntil:''}});
      await status(job.shop,{lastReceivedAt:job.receivedAt,lastProcessedAt:now,processingError:null});
      return true;
    } catch(error) {
      const delay = Math.min(5*60*1000,5000*2**Math.min(job.attempts || 1,6));
      await WebhookJob.updateOne({_id:job._id}, {$set:{status:'pending',nextAttemptAt:new Date(Date.now()+delay),error:error.message},$unset:{lockedUntil:''}});
      await status(job.shop,{processingError:error.message});
      return false;
    }
  }
  let pumping = false;
  async function pump(shop) {
    if (pumping) return;
    pumping = true;
    try {
      for (let count = 0; count < 10; count++) {
        const now = new Date();
        const job = await WebhookJob.findOneAndUpdate({shop,$or:[{status:'pending',nextAttemptAt:{$lte:now}},{status:'processing',lockedUntil:{$lte:now}}]},
          {$set:{status:'processing',lockedUntil:new Date(now.getTime()+10*60*1000)},$inc:{attempts:1}}, {sort:{receivedAt:1},new:true}).lean();
        if (!job) break;
        await process(job);
      }
    } finally {pumping = false;}
  }
  return {ensure,receive,pump,process};
}
