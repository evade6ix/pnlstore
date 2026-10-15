import {CATALOG_FIELDS, catalogRecord, inventoryRow} from './catalog.js';

export const EDIT_QUERY = `query InventoryEditor($id: ID!, $after: String) {
  shop { currencyCode }
  productVariant(id: $id) {
    ${CATALOG_FIELDS}
    inventoryItem { id inventoryLevels(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { location { id name isActive } quantities(names: ["available"]) { name quantity } }
    } }
  }
}`;
export const EDIT_MUTATION = `mutation EditInventoryVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: false) {
    productVariants { id }
    userErrors { field message }
  }
}`;
export function editError(message, status = 400) {return Object.assign(new Error(message), {status});}
function decimal(value, label) {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '' ||
    !Number.isFinite(Number(value)) || Number(value) < 0) throw editError(`${label} must be a non-negative number.`);
  return Number(value);
}
export function buildVariantUpdate(current, input) {
  if (!input || typeof input !== 'object' || !input.expected) throw editError('Reload the editor before saving.');
  const variant = {id:current.variantId};
  if (input.price !== undefined) {
    const price = decimal(input.price, 'Price');
    if (price !== current.price) {
      if (Number(input.expected.price) !== current.price) throw editError('Price changed in Shopify. Reload the editor before saving.', 409);
      variant.price = price.toFixed(2);
    }
  }
  if (input.unitCost !== undefined) {
    const cost = decimal(input.unitCost, 'Cost');
    if (cost !== current.unitCost) {
      if (input.expected.unitCost !== current.unitCost) throw editError('Cost changed in Shopify. Reload the editor before saving.', 409);
      variant.inventoryItem = {cost:String(cost)};
    }
  }
  if (input.locations !== undefined) {
    if (!Array.isArray(input.locations) || input.locations.length > 250) throw editError('Invalid inventory locations.');
    const seen = new Set(), adjustments = [];
    for (const change of input.locations) {
      const level = current.locations.find(location => location.id === change.locationId);
      if (!level || !level.active || !current.tracked || seen.has(change.locationId)) throw editError('Invalid or inactive inventory location.');
      seen.add(change.locationId);
      if (!Number.isSafeInteger(change.quantity) || Math.abs(change.quantity) > 2147483647 || !Number.isSafeInteger(change.expectedQuantity)) throw editError('Inventory quantity must be a whole number.');
      if (change.expectedQuantity !== level.quantity) throw editError(`Stock changed at ${level.name}. Reload the editor before saving.`, 409);
      if (change.quantity !== level.quantity) adjustments.push({locationId:level.id, adjustment:change.quantity - level.quantity, changeFromQuantity:level.quantity});
    }
    if (adjustments.length) variant.quantityAdjustments = adjustments;
  }
  return variant;
}

export function createInventoryEditor({gql, Catalog, syncCatalog}) {
  async function read(shop, record) {
    let after = null, current, locations = [];
    do {
      const data = await gql(shop, EDIT_QUERY, {id:record.variantId, after});
      const node = data.productVariant;
      if (!node || node.product.id !== record.productId) throw editError('This product is no longer available in Shopify.', 404);
      current = inventoryRow(catalogRecord(node, shop, data.shop.currencyCode, new Date()));
      const levels = node.inventoryItem.inventoryLevels;
      locations.push(...levels.nodes.map(level => ({id:level.location.id, name:level.location.name,
        active:level.location.isActive, quantity:level.quantities.find(q => q.name === 'available')?.quantity ?? 0})));
      if (levels.pageInfo.hasNextPage && (!levels.pageInfo.endCursor || levels.pageInfo.endCursor === after)) throw editError('Could not load all inventory locations.', 502);
      after = levels.pageInfo.hasNextPage ? levels.pageInfo.endCursor : null;
    } while (after);
    return {...current, locations};
  }
  async function save(shop, record, input) {
    const current = await read(shop, record);
    const variant = buildVariantUpdate(current, input);
    if (Object.keys(variant).length === 1) return {item:current, message:'No changes to save.'};
    let mutation;
    try {mutation = await gql(shop, EDIT_MUTATION, {productId:current.productId, variants:[variant]});}
    catch (error) {
      // Never retry a write automatically: Shopify may have applied it before
      // a network timeout. Let the user reload the authoritative values.
      throw editError(`Shopify could not confirm the save: ${error.message}. Reload the editor to check current values before retrying.`, 502);
    }
    const errors = mutation.productVariantsBulkUpdate.userErrors;
    if (errors.length) throw editError(errors.map(e => e.message).join('; '), 409);
    if (!mutation.productVariantsBulkUpdate.productVariants?.some(v => v.id === record.variantId)) throw editError('Shopify did not confirm the updated variant. Reload the editor.', 502);
    let item;
    try {
      item = await read(shop, record);
      const {locations, ...snapshot} = item;
      await Catalog.updateOne({shop, variantId:record.variantId}, {$set:snapshot});
      await syncCatalog(shop, {fresh:true});
    } catch (error) {
      return {saved:true, message:'Saved to Shopify. Inventory refresh needs attention; click Sync products.', warning:error.message, item:item || null};
    }
    return {saved:true, item, message:'Saved to Shopify.'};
  }
  return {read, save};
}
