import test from 'node:test';
import assert from 'node:assert/strict';
import {parseStoreCreditGiven,importedShopifyFinancials,financialSyncValues} from './shopify-financial-import.js';
const sample={
  currencyCode:'CAD',presentmentCurrencyCode:'USD',
  currentTotalPriceSet:{shopMoney:{amount:'140.39',currencyCode:'CAD'},presentmentMoney:{amount:'99.00',currencyCode:'USD'}},
  metafield:{namespace:'dollar-cashback',key:'store-credit-given',value:'$1.98'},
  transactions:[
    {id:'auth',kind:'AUTHORIZATION',status:'SUCCESS',settlementCurrency:'CAD',fees:[]},
    {id:'capture',kind:'CAPTURE',status:'SUCCESS',settlementCurrency:'CAD',settlementCurrencyRate:'1.4181',
      fees:[{type:'processing_fee',amount:{amount:'3.68',currencyCode:'USD'},taxAmount:{amount:'0',currencyCode:'USD'}},
        {type:'foreign_exchange_fee',amount:{amount:'1.94',currencyCode:'USD'},taxAmount:{amount:'0',currencyCode:'USD'}}]}
  ]
};
test('GNH USD payment processor and FX fees converted into CAD using settlement rate',()=>{
  const r=importedShopifyFinancials(sample);
  assert.equal(r.paymentFees,7.97);assert.equal(r.paymentFeeBreakdown.length,2);
  assert.equal(r.paymentFeeBreakdown[0].amount,5.22);
  assert.equal(r.paymentFeeBreakdown[1].amount,2.75);
  assert.equal(r.storeCreditOriginal,1.98);
  assert.equal(r.storeCreditCurrency,'USD');assert.equal(r.storeCreditGiven,2.81);
  const saved=financialSyncValues(null,r);
  assert.equal(saved.paymentFees,7.97);assert.equal(saved.cashbackCost,2.81);
  assert.equal(saved.paymentFeeSource,'shopify');assert.equal(saved.cashbackSource,'shopify-metafield');
});
test('manual processing fee and cashback overrides survive later automatic sync',()=>{
  const r=financialSyncValues({paymentFees:10,cashbackCost:4,paymentFeeSource:'manual',cashbackSource:'manual'},importedShopifyFinancials(sample));
  assert.equal(r.paymentFees,undefined);assert.equal(r.cashbackCost,undefined);
  assert.equal(r.storeCreditGiven,2.81);assert.equal(r.paymentFeeSource,'manual');assert.equal(r.cashbackSource,'manual');
});
test('legacy manual values are protected, untouched zero amounts can populate',()=>{
  const imported=importedShopifyFinancials(sample);
  const manual=financialSyncValues({paymentFees:11,cashbackCost:7},imported);
  assert.equal(manual.paymentFeeSource,'manual');assert.equal(manual.cashbackSource,'manual');
  const empty=financialSyncValues({paymentFees:0,cashbackCost:0},imported);
  assert.equal(empty.paymentFees,7.97);assert.equal(empty.cashbackCost,2.81);
});
test('CAD payments and store credit are not converted',()=>{
  const node={...sample,presentmentCurrencyCode:'CAD',metafield:{...sample.metafield,value:'$2.00'},
    transactions:[{id:'sale',kind:'SALE',status:'SUCCESS',settlementCurrency:'CAD',fees:[{type:'processing_fee',amount:{amount:'2.60',currencyCode:'CAD'},taxAmount:{amount:'0',currencyCode:'CAD'}}]}]};
  const r=importedShopifyFinancials(node);
  assert.equal(r.paymentFees,2.6);assert.equal(r.storeCreditGiven,2);
});
test('unconvertible fee currencies must not silently mix with CAD amounts',()=>{
  const node={...sample,transactions:[{...sample.transactions[1],settlementCurrencyRate:null,settlementCurrency:'EUR',
    fees:[{type:'processing_fee',amount:{amount:'3',currencyCode:'EUR'}}]}]};
  const result=importedShopifyFinancials(node);
  assert.equal(result.paymentFees,null);
  const saved=financialSyncValues({paymentFees:9,paymentFeeSource:'manual'},result);
  assert.equal(saved.paymentFees,undefined);
});
test('missing rewards metadata is distinct from zero credit',()=>{
  assert.equal(parseStoreCreditGiven('$0.00'),0);
  assert.equal(parseStoreCreditGiven('$1,234.56'),1234.56);
  assert.equal(parseStoreCreditGiven('$junk'),null);
  const imported=importedShopifyFinancials({...sample,metafield:null});
  assert.equal(imported.storeCreditPresent,false);
  assert.equal(imported.storeCreditGiven,null);
  const old=financialSyncValues({cashbackSource:'shopify-metafield',cashbackCost:10},imported);
  assert.equal(old.cashbackCost,0);
});
test('failed authorizations cannot change fee totals',()=>{
  const imported=importedShopifyFinancials({...sample,transactions:[{...sample.transactions[1],status:'FAILURE'}]});
  assert.equal(imported.paymentFees,null);
});
