// Shared reporting definition for a saved Shopify order.
// Shopify discounts, returns and refunded shipping are already reflected in
// netSales and shippingRevenue. Subtracting them again understates profit.
export function orderFinancials(order={}){
  const value=key=>Number(order[key]||0);
  const round=n=>Math.round((n+Number.EPSILON)*100)/100;
  const revenue=round(value('netSales')+value('shippingRevenue'));
  const shippingCost=value('shippingCost'),paymentFees=value('paymentFees');
  const materialCost=value('materialCost'),cashbackCost=value('cashbackCost');
  const otherVariableCost=value('otherVariableCost'),cogs=value('cogs');
  const variableCosts=round(shippingCost+paymentFees+materialCost+cashbackCost+otherVariableCost);
  const takeHome=round(revenue-variableCosts);
  const profit=round(takeHome-cogs);
  return {revenue,shippingCost,paymentFees,materialCost,cashbackCost,otherVariableCost,
    variableCosts,cogs,takeHome,profit,margin:revenue?round(profit/revenue*100):0,
    costsReviewed:order.costsReviewed===true};
}
