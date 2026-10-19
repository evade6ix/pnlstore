import test from 'node:test';
import assert from 'node:assert/strict';
import {Order} from './models.js';
import {persistOrder} from './shopify.js';
import {paymentStatus} from '../src/payment-status.js';

test('payment display uses the manual choice, then imported status, then not set',()=>{
  assert.equal(paymentStatus({financialStatus:'PAID'}),'paid');
  assert.equal(paymentStatus({financialStatus:'PARTIALLY_PAID'}),'partially_paid');
  assert.equal(paymentStatus({financialStatus:'REFUNDED'}),'refunded');
  assert.equal(paymentStatus({financialStatus:'PAID',paymentStatus:'unpaid'}),'unpaid');
  assert.equal(paymentStatus({source:'manual'}),'unknown');
});

test('Shopify sync updates its own status without replacing the stored manual payment choice',async t=>{
  const existing={shopifyId:'gid://shopify/Order/123',paymentStatus:'unpaid',updatedAt:new Date(),lines:[]};
  const node={id:existing.shopifyId,name:'#123',createdAt:'2026-10-19T12:00:00Z',displayFinancialStatus:'PAID',currencyCode:'CAD',lineItems:{edges:[]}};
  t.mock.method(Order,'findOne',()=>({lean:async()=>existing}));
  t.mock.method(Order,'findOneAndUpdate',async(filter,update)=>{
    assert.equal(Object.hasOwn(update.$set,'paymentStatus'),false);
    return {...existing,...update.$set};
  });
  const result=await persistOrder(node);
  assert.equal(result.financialStatus,'PAID');
  assert.equal(result.paymentStatus,'unpaid');
});
