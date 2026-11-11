// Shopify Payments transaction fees and Dollar Cashback order metafield are
// denominated in the shopper's currency, while the ledger is denominated in
// Shopify's shop currency (normally CAD).
const round=n=>Math.round((n+Number.EPSILON)*100)/100;
const finite=n=>Number.isFinite(Number(n))?Number(n):null;
const moneyValue=item=>finite(item?.amount);
const CREDIT_NAMESPACE='dollar-cashback';
const CREDIT_KEY='store-credit-given';

export function parseStoreCreditGiven(raw){
  if(typeof raw!=='string')return null;
  const value=raw.trim();
  const match=value.match(/^(?:(?:CAD|USD|EUR)\s*)?\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,4})?|[0-9]+(?:\.[0-9]{1,4})?)\s*(?:CAD|USD|EUR)?$/i);
  if(!match)return null;
  const n=Number(match[1].replace(/,/g,''));
  return Number.isFinite(n)&&n>=0?round(n):null;
}

export function importedShopifyFinancials(node){
  const shopCurrency=node.currentTotalPriceSet?.shopMoney?.currencyCode||node.currencyCode||'CAD';
  const presentmentCurrency=node.presentmentCurrencyCode||shopCurrency;
  const transactions=(node.transactions||[]).filter(t=>t.status==='SUCCESS'&&['CAPTURE','SALE','REFUND'].includes(t.kind));
  const capture=transactions.find(t=>['CAPTURE','SALE'].includes(t.kind)&&t.settlementCurrency===shopCurrency&&Number(t.settlementCurrencyRate)>0);
  const rate=capture?Number(capture.settlementCurrencyRate):null;
  const priceShop=moneyValue(node.currentTotalPriceSet?.shopMoney);
  const pricePresentment=moneyValue(node.currentTotalPriceSet?.presentmentMoney);
  const priceRate=priceShop!=null&&pricePresentment>0?priceShop/pricePresentment:null;
  function converted(amount,currency,transaction){
    if(amount==null||!currency)return null;
    if(currency===shopCurrency)return amount;
    if(currency!==presentmentCurrency)return null;
    const txRate=Number(transaction?.settlementCurrencyRate);
    if(transaction?.settlementCurrency===shopCurrency&&Number.isFinite(txRate)&&txRate>0)return amount*txRate;
    if(transaction?.amountSet?.shopMoney?.currencyCode===shopCurrency&&
       transaction?.amountSet?.presentmentMoney?.currencyCode===presentmentCurrency){
      const shopAmount=moneyValue(transaction.amountSet.shopMoney),originalAmount=moneyValue(transaction.amountSet.presentmentMoney);
      if(shopAmount!=null&&originalAmount>0)return amount*shopAmount/originalAmount;
    }
    if(rate)return amount*rate;
    if(priceRate&&Number.isFinite(priceRate))return amount*priceRate;
    return null;
  }
  let feeBreakdown=[],unconvertible=false;
  for(const t of transactions){
    for(const fee of t.fees||[]){
      const feeCurrency=fee.amount?.currencyCode;
      const amount=moneyValue(fee.amount),tax=moneyValue(fee.taxAmount);
      const amountCAD=converted((amount??0)+(tax??0),feeCurrency,t);
      if(amount==null||amountCAD==null||!Number.isFinite(amountCAD)){unconvertible=true;continue;}
      feeBreakdown.push({transactionId:t.id,type:fee.type||'fee',originalAmount:round(amount+(tax??0)),
        originalCurrency:feeCurrency,amount:round(amountCAD),currency:shopCurrency});
    }
  }
  const paymentFees=feeBreakdown.length&&!unconvertible?round(feeBreakdown.reduce((total,f)=>total+f.amount,0)):null;
  const field=node.metafield||null;
  const fieldIsCorrect=!field||(field.namespace===CREDIT_NAMESPACE&&field.key===CREDIT_KEY);
  const original=field&&fieldIsCorrect?parseStoreCreditGiven(field.value):null;
  const creditCAD=original!=null?converted(original,presentmentCurrency,capture):null;
  return {paymentFees,paymentFeeBreakdown:!unconvertible?feeBreakdown:[],
    storeCreditGiven:creditCAD!=null?round(creditCAD):null,
    storeCreditOriginal:original,storeCreditCurrency:field?presentmentCurrency:null,
    storeCreditRaw:field?.value??null,storeCreditPresent:!!field,
    feeSourceAvailable:paymentFees!=null};
}

export function financialSyncValues(existing,imported){
  const result={storeCreditGiven:imported.storeCreditGiven,
    storeCreditOriginal:imported.storeCreditOriginal,
    storeCreditCurrency:imported.storeCreditCurrency,
    storeCreditRaw:imported.storeCreditRaw,
    paymentFeeBreakdown:imported.paymentFeeBreakdown};
  const paymentSource=existing?.paymentFeeSource||(Number(existing?.paymentFees||0)!==0?'manual':null);
  const creditSource=existing?.cashbackSource||(Number(existing?.cashbackCost||0)!==0?'manual':null);
  if(paymentSource==='manual')result.paymentFeeSource='manual';
  else if(imported.paymentFees!=null){result.paymentFees=imported.paymentFees;result.paymentFeeSource='shopify';}
  else result.paymentFeeSource=paymentSource||'unavailable';
  if(creditSource==='manual')result.cashbackSource='manual';
  else if(imported.storeCreditPresent&&imported.storeCreditGiven!=null){
    result.cashbackCost=imported.storeCreditGiven;result.cashbackSource='shopify-metafield';
  }else if(!imported.storeCreditPresent&&creditSource==='shopify-metafield'){
    result.cashbackCost=0;result.cashbackSource='unavailable';
  }else result.cashbackSource=creditSource||'unavailable';
  return result;
}
