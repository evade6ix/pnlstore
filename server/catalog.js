export const CATALOG_INTERVAL_MS = 5 * 60 * 1000;
export const CATALOG_FIELDS = `id title sku price inventoryQuantity
  inventoryItem { tracked unitCost { amount currencyCode } }
  product { id title status featuredMedia { preview { image { url altText } } } }`;
export const CATALOG_QUERY = `query InventoryCatalog($after: String) {
  shop { currencyCode }
  productVariants(first: 100, after: $after, sortKey: ID) {
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
    variantTitle:node.title, sku:node.sku || '', status:node.product.status,
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
    missingCosts:0, missingCostStock:0, untracked:0, variants:rows.length};
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

// Fetch the complete catalog before mutating local records. A failed page must
// never look like a deleted product or clear a previously successful import.
export function createCatalogSync({gql, Catalog, Setting}) {
  const running = new Map();
  return function syncCatalog(shop, {fresh = false} = {}) {
    if (fresh && running.has(shop)) return running.get(shop).catch(() => {}).then(() => syncCatalog(shop, {fresh:true}));
    if (running.has(shop)) return running.get(shop);
    const task = (async () => {
      const key = `catalog:${shop}`;
      try {
        let after = null, currency, records = [];
        const syncedAt = new Date();
        do {
          let data;
          for (let attempt = 0; ; attempt++) {
            try { data = await gql(shop, CATALOG_QUERY, {after}); break; }
            catch (error) {
              if (attempt >= 3 || !/throttl|429|502|503|504/i.test(error.message)) throw error;
              await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
            }
          }
          currency = data.shop.currencyCode;
          records.push(...data.productVariants.nodes.map(node => catalogRecord(node, shop, currency, syncedAt)));
          const page = data.productVariants.pageInfo;
          if (page.hasNextPage && (!page.endCursor || page.endCursor === after)) throw new Error('Shopify returned an invalid pagination cursor');
          after = page.hasNextPage ? page.endCursor : null;
        } while (after);
        if (records.length) await Catalog.bulkWrite(records.map(record => ({updateOne:{
          filter:{shop, variantId:record.variantId}, update:{$set:record}, upsert:true
        }})));
        await Catalog.deleteMany({shop, lastSyncedAt:{$ne:syncedAt}});
        const result = {lastSyncedAt:syncedAt, variants:records.length,
          products:new Set(records.map(r => r.productId)).size, currency, error:null};
        await Setting.findOneAndUpdate({key}, {$set:{value:result}}, {upsert:true});
        return result;
      } catch (error) {
        await Setting.findOneAndUpdate({key}, {$set:{'value.error':error.message}}, {upsert:true});
        throw error;
      }
    })().finally(() => running.delete(shop));
    running.set(shop, task);
    return task;
  };
}
