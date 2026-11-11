import test from 'node:test';
import assert from 'node:assert/strict';
import {orderFinancials} from './order-finance.js';

test('Shopify order net revenue is already after discount and refund',()=>{
  const order={grossSales:120,discounts:10,returns:20,netSales:90,shippingRevenue:8,
    cogs:45,shippingCost:6,paymentFees:3,materialCost:1,cashbackCost:5,otherVariableCost:0};
  const r=orderFinancials(order);
  assert.equal(r.revenue,98);
  assert.equal(r.takeHome,83);
  assert.equal(r.profit,38);
  assert.equal(r.margin,38.78);
});
test('no manual costs are treated as unreviewed, not confirmed profit',()=>{
  const r=orderFinancials({netSales:50,cogs:20});
  assert.equal(r.profit,30);
  assert.equal(r.costsReviewed,false);
});
test('cashback is separate from Shopify discounts',()=>{
  const a=orderFinancials({netSales:100,cogs:60,cashbackCost:7,costsReviewed:true});
  assert.equal(a.profit,33);
  assert.equal(a.costsReviewed,true);
});
