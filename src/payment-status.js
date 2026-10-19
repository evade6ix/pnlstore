export function paymentStatus(order){
  if(order.paymentStatus==='paid'||order.paymentStatus==='unpaid')return order.paymentStatus;
  return String(order.financialStatus||'unknown').toLowerCase();
}
export const paymentLabels={paid:'Paid',unpaid:'Unpaid',pending:'Unpaid',authorized:'Authorized',partially_paid:'Partially paid',partially_refunded:'Partially refunded',refunded:'Refunded',voided:'Voided',expired:'Expired',unknown:'Not set'};
