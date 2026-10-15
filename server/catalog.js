export const CATALOG_INTERVAL_MS = 60 * 60 * 1000;
export const CATALOG_FIELDS = `id title sku price inventoryQuantity
  inventoryItem { id tracked unitCost { amount currencyCode } }
  product { id title status featuredMedia { preview { image { url altText } } } }`;
export const CATALOG_QUERY = `query InventoryCatalog($after: String, $filter: String) {
  shop { currencyCode }
  productVariants(first: 100, after: $after, sortKey: ID, query: $filter) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ${CATALOG_FIELDS}
    }
  }
}`;

export function catalogRecord(node, shop, currency, syncedAt) {
  const cost = node.inventoryItem.unitCost;
  if (cost && cost.currencyCode !== currency) throw new Error('Inventory cost currency differs from store currency');
  const image = node.product.featuredMedia?.preview?.image;
  return {shop, variantId:node.id, productId:node.product.id, title:node.product.title,
    inventoryItemId:node.inventoryItem.id, variantTitle:node.title, sku:node.sku || '', status:node.product.status,
    imageUrl:image?.url || '', imageAlt:image?.altText || node.product.title,
    price:Number(node.price), unitCost:cost == null ? null : Number(cost.amount),
    quantity:node.inventoryItem.tracked ? node.inventoryQuantity : null,
    tracked:node.inventoryItem.tracked, currency, lastSyncedAt:syncedAt};
}

export function inventoryRow(record) {
  const quantity = record.quantity == null ? null : Math.max(0, record.quantity);
  const unitProfit = record.unitCost == null ? null : record.price - record.unitCost;
  return {...record, unitProfit, margin:unitProfit == null || record.price <= 0 ? null : unitProfit / record.price * 100,
    inventoryValue:quantity == null ? null : record.price * quantity,
    inventoryCost:quantity == null || record.unitCost == null ? null : record.unitCost * quantity,
    totalProfit:quantity == null || unitProfit == null ? null : unitProfit * quantity};
}

export function inventoryTotals(rows) {
  const totals = {inventoryValue:0, inventoryCost:0, totalProfit:0, knownCostValue:0, quantity:0,
    missingCosts:0, missingCostStock:0, untracked:0, variants:rows.length, products:new Set(rows.map(row => row.productId)).size};
  for (const row of rows) {
    totals.quantity += Math.max(0, row.quantity || 0);
    totals.inventoryValue += row.inventoryValue ?? 0;
    totals.inventoryCost += row.inventoryCost ?? 0;
    totals.totalProfit += row.totalProfit ?? 0;
    if (row.inventoryCost != null) totals.knownCostValue += row.inventoryValue;
    if (row.unitCost == null) { totals.missingCosts++; if (row.quantity > 0) totals.missingCostStock++; }
    if (row.quantity == null) totals.untracked++;
  }
  totals.margin = totals.knownCostValue > 0 ? totals.totalProfit / totals.knownCostValue * 100 : null;
  return totals;
}

// Read every page before changing records. Both full and product refreshes use
// the same per-shop queue so an older full scan cannot overwrite a webhook.
export function createCatalogSync({gql, Catalog, Setting}) {
  const running = new Map();
  function enqueue(shop, kind, operation) {
    const previous = running.get(shop);
    const entry = {kind};
    const execute = () => operation();
    entry.promise = (previous ? previous.promise.catch(() => {}).then(execute) : execute())
      .finally(() => {if (running.get(shop) === entry) running.delete(shop);});
    running.set(shop, entry);
    return entry.promise;
  }
  async function fetchRecords(shop, productId) {
    let after = null, currency, records = [];
    const syncedAt = new Date();
    const filter = productId ? `product_id:${productId.split('/').pop()}` : null;
    do {
      let data;
      for (let attempt = 0; ; attempt++) {
        try {data = await gql(shop, CATALOG_QUERY, {after, filter}); break;}
        catch (error) {
          if (attempt >= 3 || !/throttl|429|502|503|504/i.test(error.message)) throw error;
          await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
        }
      }
      currency = data.shop.currencyCode;
      const batch = data.productVariants.nodes.map(node => catalogRecord(node, shop, currency, syncedAt));
      if (productId && batch.some(record => record.productId !== productId)) throw new Error('Shopify returned an unexpected product');
      records.push(...batch);
      const page = data.productVariants.pageInfo;
      if (page.hasNextPage && (!page.endCursor || page.endCursor === after)) throw new Error('Shopify returned an invalid pagination cursor');
      after = page.hasNextPage ? page.endCursor : null;
    } while (after);
    return {records, currency, syncedAt};
  }
  async function persist(shop, productId) {
    const {records, currency, syncedAt} = await fetchRecords(shop, productId);
    if (records.length) await Catalog.bulkWrite(records.map(record => ({updateOne:{
      filter:{shop, variantId:record.variantId}, update:{$set:record}, upsert:true
    }})));
    await Catalog.deleteMany({shop, ...(productId ? {productId} : {}), lastSyncedAt:{$ne:syncedAt}});
    return {lastSyncedAt:syncedAt, variants:records.length, products:new Set(records.map(r => r.productId)).size, currency, error:null};
  }
  function syncCatalog(shop, {fresh = false} = {}) {
    const existing = running.get(shop);
    if (!fresh && existing?.kind === 'full') return existing.promise;
    return enqueue(shop, 'full', async () => {
      const key = `catalog:${shop}`;
      try {
        const result = await persist(shop);
        await Setting.findOneAndUpdate({key}, {$set:{value:result}}, {upsert:true});
        return result;
      } catch (error) {
        await Setting.findOneAndUpdate({key}, {$set:{'value.error':error.message}}, {upsert:true});
        throw error;
      }
    });
  }
  syncCatalog.refreshProduct = (shop, productId) => {
    if (!/^gid:\/\/shopify\/Product\/\d+$/.test(productId)) return Promise.reject(new Error('Invalid product ID'));
    return enqueue(shop, 'product', () => persist(shop, productId));
  };
  return syncCatalog;
}
