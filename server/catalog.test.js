import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogRecord, inventoryRow, inventoryTotals, createCatalogSync} from './catalog.js';

const node = (id, changes = {}) => ({id, title:'Default Title', sku:null, price:'19.95', inventoryQuantity:10,
  inventoryItem:{tracked:true, unitCost:{amount:'14.25',currencyCode:'CAD'}},
  product:{id:`product-${id}`,title:'Test product',status:'ACTIVE',featuredMedia:null}, ...changes});
const row = (changes = {}) => inventoryRow(catalogRecord(node('1', changes), 'test.myshopify.com', 'CAD', new Date()));

test('inventory uses gross margin, not markup, and multiplies profit by stock', () => {
  const item = row();
  assert.ok(Math.abs(item.margin - 28.57142857) < 0.00001);
  assert.ok(Math.abs(item.totalProfit - 57) < 0.00001);
  assert.equal(item.inventoryValue, 199.5);
  assert.equal(item.inventoryCost, 142.5);
});

test('missing costs, untracked quantities, negative stock, and zero prices do not invent profits', () => {
  const missing = row({inventoryItem:{tracked:true,unitCost:null}});
  assert.equal(missing.totalProfit, null);
  const untracked = row({inventoryItem:{tracked:false,unitCost:{amount:'14.25',currencyCode:'CAD'}}});
  assert.equal(untracked.inventoryValue, null);
  const negative = row({inventoryQuantity:-5});
  assert.equal(negative.totalProfit, 0);
  assert.equal(negative.quantity, -5);
  assert.equal(row({price:'0'}).margin, null);
  const zeroCost = row({inventoryItem:{tracked:true,unitCost:{amount:'0',currencyCode:'CAD'}}});
  assert.equal(zeroCost.margin, 100);
  const totals = inventoryTotals([row(), missing, untracked, negative]);
  assert.equal(totals.inventoryValue, 399);
  assert.equal(totals.inventoryCost, 142.5);
  assert.equal(totals.missingCostStock, 1);
  assert.equal(totals.untracked, 1);
  assert.ok(Math.abs(totals.margin - row().margin) < 0.00001);
});

test('costs in another currency are rejected', () => {
  assert.throws(() => row({inventoryItem:{tracked:true,unitCost:{amount:'10',currencyCode:'USD'}}}), /currency/);
});

function harness(gql) {
  const writes = [], deletes = [], settings = [];
  return {writes, deletes, settings, sync:createCatalogSync({gql,
    Catalog:{bulkWrite:async items => writes.push(items), deleteMany:async filter => deletes.push(filter)},
    Setting:{findOneAndUpdate:async (...args) => settings.push(args)}
  })};
}
const page = (nodes, more = false, cursor = null) => ({shop:{currencyCode:'CAD'},productVariants:{nodes,pageInfo:{hasNextPage:more,endCursor:cursor}}});

test('full variant pagination, deduplication of simultaneous syncs, and shop-scoped cleanup', async () => {
  const cursors = [];
  const h = harness(async (shop, query, {after}) => {cursors.push(after); return after ? page([node('2')]) : page([node('1')], true, 'next');});
  const first = h.sync('test.myshopify.com');
  assert.equal(first, h.sync('test.myshopify.com'));
  const result = await first;
  assert.deepEqual(cursors, [null, 'next']);
  assert.equal(result.variants, 2);
  assert.equal(h.writes[0].length, 2);
  assert.equal(h.deletes[0].shop, 'test.myshopify.com');
  assert.equal(h.writes[0][0].updateOne.upsert, true);
});

test('failed second page leaves the last complete catalog intact and allows retry', async () => {
  let fail = true;
  const h = harness(async (shop, query, {after}) => {
    if (after && fail) throw new Error('Access denied');
    return after ? page([node('2')]) : page([node('1')], true, 'next');
  });
  await assert.rejects(h.sync('test.myshopify.com'), /Access denied/);
  assert.equal(h.writes.length, 0);
  assert.equal(h.deletes.length, 0);
  assert.equal(h.settings[0][1].$set['value.error'], 'Access denied');
  fail = false;
  assert.equal((await h.sync('test.myshopify.com')).variants, 2);
});

test('empty catalog clears deleted products only after a successful Shopify fetch', async () => {
  const h = harness(async () => page([]));
  assert.equal((await h.sync('test.myshopify.com')).variants, 0);
  assert.equal(h.writes.length, 0);
  assert.equal(h.deletes.length, 1);
});
