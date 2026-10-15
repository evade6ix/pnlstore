import 'dotenv/config';import express from 'express';import mongoose from 'mongoose';import helmet from 'helmet';import compression from 'compression';import crypto from 'crypto';import path from 'path';import {fileURLToPath} from 'url';import {Order,Cost,Expense,Purchase,Session,Catalog,Setting,WebhookJob} from './models.js';import {normalizeShop,verifyHmac,syncOrders,verifyWebhook,persistOrder,gql,ORDER_FIELDS} from './shopify.js';
import {createCatalogSync,inventoryRow,inventoryTotals,CATALOG_INTERVAL_MS} from './catalog.js';
import {createInventoryEditor,editError} from './inventory-edit.js';
import {WRITE_SCOPES,safeEqual,cookieValue,ownerToken,editingAccess,refreshGrantedScopes,editingReturnUrl} from './owner-auth.js';
import {createCatalogWebhooks,validWebhook} from './catalog-webhooks.js';
import {createLedgerRouter} from './ledger.js';
const syncCatalog=createCatalogSync({gql,Catalog,Setting});
const inventoryEditor=createInventoryEditor({gql,Catalog,syncCatalog});
const catalogWebhooks=createCatalogWebhooks({gql,Catalog,Setting,WebhookJob,syncCatalog,appUrl:process.env.SHOPIFY_APP_URL});
const cookieOptions={httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'lax',path:'/'};
const app=express(),port=process.env.PORT||3000;app.use(helmet({contentSecurityPolicy:false,crossOriginEmbedderPolicy:false}));app.use(compression());
const asyncRoute=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);const shop=()=>normalizeShop(process.env.SHOPIFY_SHOP);
app.get('/health',(req,res)=>res.json({ok:true,time:new Date()}));
app.get('/auth',asyncRoute(async(req,res)=>{
  const s=normalizeShop(req.query.shop)||shop();
  if(!s||s!==shop())return res.status(400).send('Invalid shop');
  const state=crypto.randomBytes(32).toString('hex');
  res.cookie('oauth_state',state,{...cookieOptions,maxAge:10*60*1000});
  res.cookie('oauth_edit',req.query.edit==='1'?'1':'0',{...cookieOptions,maxAge:10*60*1000});
  const scopes=new Set((process.env.SHOPIFY_SCOPES||'read_orders,read_products,read_inventory,read_locations').split(',').filter(Boolean));
  if(req.query.edit==='1')WRITE_SCOPES.forEach(scope=>scopes.add(scope));
  const redirect=`${process.env.SHOPIFY_APP_URL}/auth/callback`;
  res.redirect(`https://${s}/admin/oauth/authorize?client_id=${process.env.SHOPIFY_CLIENT_ID}&scope=${encodeURIComponent([...scopes].join(','))}&redirect_uri=${encodeURIComponent(redirect)}&state=${state}`);
}));
app.get('/auth/callback',asyncRoute(async(req,res)=>{
  const s=normalizeShop(req.query.shop);
  if(s!==shop()||!safeEqual(cookieValue(req,'oauth_state'),req.query.state)||!verifyHmac(req.query))return res.status(401).send('Invalid OAuth state or signature. Please start the connection again.');
  const editingRequested=cookieValue(req,'oauth_edit')==='1';
  res.clearCookie('oauth_state',cookieOptions);res.clearCookie('oauth_edit',cookieOptions);
  const r=await fetch(`https://${s}/admin/oauth/access_token`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:process.env.SHOPIFY_CLIENT_ID,client_secret:process.env.SHOPIFY_CLIENT_SECRET,code:req.query.code}),signal:AbortSignal.timeout(30000)});
  const t=await r.json();if(!r.ok||!t.access_token)throw new Error('Could not obtain Shopify token');
  await Session.findOneAndUpdate({shop:s},{$set:{accessToken:t.access_token,scope:t.scope,installedAt:new Date()}},{upsert:true});
  res.cookie('pnl_owner',ownerToken(s,process.env.SHOPIFY_CLIENT_SECRET),{...cookieOptions,maxAge:12*60*60*1000});
  syncCatalog(s).catch(error=>console.error('Catalog sync:',error.message));
  catalogWebhooks.ensure(s).catch(error=>console.error('Catalog webhooks:',error.message));
  let grantedScope=t.scope;
  try{grantedScope=await refreshGrantedScopes(s,{gql,Session});}catch(error){console.error('Permission check:',error.message);}
  res.redirect(editingRequested?editingReturnUrl(grantedScope):'/inventory?connected=1');
}));
app.post('/webhooks/catalog',express.raw({type:'application/json',limit:'5mb'}),asyncRoute(async(req,res)=>{
  if(!validWebhook(req.body,req.get('X-Shopify-Hmac-Sha256'),process.env.SHOPIFY_CLIENT_SECRET))return res.sendStatus(401);
  const s=normalizeShop(req.get('X-Shopify-Shop-Domain'));
  if(!s||s!==shop())return res.sendStatus(403);
  let payload;try{payload=JSON.parse(req.body.toString());}catch{return res.status(400).json({error:'Invalid webhook JSON'});}
  await catalogWebhooks.receive(s,req.get('X-Shopify-Topic'),req.get('X-Shopify-Webhook-Id'),payload);
  res.sendStatus(200);
}));
app.post('/webhooks/orders',express.raw({type:'application/json'}),asyncRoute(async(req,res)=>{if(!verifyWebhook(req.body,req.get('X-Shopify-Hmac-Sha256')))return res.sendStatus(401);res.sendStatus(200);const id=JSON.parse(req.body.toString()).admin_graphql_api_id;const s=normalizeShop(req.get('X-Shopify-Shop-Domain'));const d=await gql(s,`query($id:ID!){order(id:$id){${ORDER_FIELDS}}}`,{id});if(d.order)await persistOrder(d.order);}));
app.use(express.json({limit:'2mb'}));
app.use('/api',createLedgerRouter({Order,Expense,Purchase,Cost,shop,secret:process.env.SHOPIFY_CLIENT_SECRET,appUrl:process.env.SHOPIFY_APP_URL}));
app.get('/api/status',asyncRoute(async(req,res)=>{const session=await Session.findOne({shop:shop()}).lean();res.json({connected:!!session,shop:shop(),scope:session?.scope||'',orders:await Order.countDocuments(),ownerAuthenticated:editingAccess(req,shop(),session?.scope,process.env.SHOPIFY_CLIENT_SECRET).authenticated,authUrl:`/auth?shop=${shop()}`});}));
app.post('/api/sync',asyncRoute(async(req,res)=>{const inventory=await syncCatalog(shop());res.json({synced:await syncOrders(shop()),inventory});}));
app.post('/api/sync/inventory',asyncRoute(async(req,res)=>res.json(await syncCatalog(shop()))));
app.get('/api/inventory',asyncRoute(async(req,res)=>{
  const s=shop(),records=await Catalog.find({shop:s}).sort({title:1,variantTitle:1}).lean();
  const rows=records.map(inventoryRow),totals=inventoryTotals(rows);
  const q=String(req.query.q||'').trim().toLowerCase();
  const filtered=rows.filter(r=>(!q||[r.title,r.variantTitle,r.sku].some(v=>v?.toLowerCase().includes(q)))&&(!req.query.inStock||r.quantity>0));
  const limit=50,page=Math.min(Math.max(1,Math.floor(Number(req.query.page)||1)),Math.max(1,Math.ceil(filtered.length/limit)));
  const sync=await Setting.findOne({key:`catalog:${s}`}).lean();
  const session=await Session.findOne({shop:s}).select('scope').lean();
  const editing=editingAccess(req,s,session?.scope,process.env.SHOPIFY_CLIENT_SECRET);
  const hookState=await Setting.findOne({key:`catalogWebhooks:${s}`}).lean();
  const pendingWebhooks=await WebhookJob.countDocuments({shop:s,status:{$ne:'done'}});
  res.json({items:filtered.slice((page-1)*limit,page*limit),total:filtered.length,page,limit,totals,editing,webhooks:hookState?.value||null,pendingWebhooks,sync:sync?.value||null,refreshMinutes:CATALOG_INTERVAL_MS/60000});
}));
const requireInventoryEditor=asyncRoute(async(req,res,next)=>{
  const session=await Session.findOne({shop:shop()}).select('scope').lean();
  const access=editingAccess(req,shop(),session?.scope,process.env.SHOPIFY_CLIENT_SECRET);
  if(!access.allowed)return res.status(access.authenticated?403:401).json({error:access.missingScopes.length?'Approve Shopify editing access to update price, cost and inventory.':'Sign in through Shopify to edit products.',editing:access});
  if(req.method==='PATCH'){
    const expectedOrigin=new URL(process.env.SHOPIFY_APP_URL).origin;
    if(req.get('origin')!==expectedOrigin||!req.is('application/json'))return res.status(403).json({error:'Save products from this workspace only.'});
  }
  next();
});
app.post('/api/inventory/access',asyncRoute(async(req,res)=>{
  const session=await Session.findOne({shop:shop()}).select('scope').lean();
  const access=editingAccess(req,shop(),session?.scope,process.env.SHOPIFY_CLIENT_SECRET);
  if(!access.authenticated)return res.status(401).json({error:'Sign in through Shopify before checking editing access.'});
  if(req.get('origin')!==new URL(process.env.SHOPIFY_APP_URL).origin||!req.is('application/json'))return res.status(403).json({error:'Check permissions from this workspace only.'});
  const scope=await refreshGrantedScopes(shop(),{gql,Session});
  res.set('Cache-Control','no-store');
  res.json(editingAccess(req,shop(),scope,process.env.SHOPIFY_CLIENT_SECRET));
}));
app.get('/api/inventory/:id/edit',requireInventoryEditor,asyncRoute(async(req,res)=>{
  const record=await Catalog.findOne({_id:req.params.id,shop:shop()}).lean();
  if(!record)throw editError('Product not found.',404);
  res.set('Cache-Control','no-store');
  res.json(await inventoryEditor.read(shop(),record));
}));
app.patch('/api/inventory/:id',requireInventoryEditor,asyncRoute(async(req,res)=>{
  const record=await Catalog.findOne({_id:req.params.id,shop:shop()}).lean();
  if(!record)throw editError('Product not found.',404);
  res.json(await inventoryEditor.save(shop(),record,req.body));
}));
const STORE_TZ=process.env.STORE_TIMEZONE||'America/Toronto';
const dateParts=(d,timeZone)=>Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(d).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
const tzOffset=(d,timeZone)=>{const p=dateParts(d,timeZone);return Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second)-d.getTime()};
const localToUtc=(dateStr,end=false)=>{const [y,m,d]=dateStr.split('-').map(Number),base=Date.UTC(y,m-1,d,end?23:0,end?59:0,end?59:0,end?999:0);let guess=new Date(base);for(let i=0;i<2;i++)guess=new Date(base-tzOffset(guess,STORE_TZ));return guess};
const range=q=>{const endText=q.end||new Date().toISOString().slice(0,10);const endDay=new Date(`${endText}T00:00:00.000Z`);const startText=q.start||`${endDay.getUTCFullYear()}-${String(endDay.getUTCMonth()+1).padStart(2,'0')}-01`;return{startText,endText,shopStart:localToUtc(startText),shopEnd:localToUtc(endText,true),ledgerStart:new Date(`${startText}T00:00:00.000Z`),ledgerEnd:new Date(`${endText}T23:59:59.999Z`)}};
app.get('/api/dashboard',asyncRoute(async(req,res)=>{const r=range(req.query),orders=await Order.find({createdAtShopify:{$gte:r.shopStart,$lte:r.shopEnd}}).lean(),expenses=await Expense.find({date:{$gte:r.ledgerStart,$lte:r.ledgerEnd}}).lean();const sum=(k)=>orders.reduce((a,o)=>a+(o[k]||0),0),expenseTotal=expenses.reduce((a,e)=>a+e.amount,0);const revenue=sum('netSales')+sum('shippingRevenue'),cogs=sum('cogs'),variable=sum('shippingCost')+sum('paymentFees')+sum('materialCost')+sum('otherVariableCost'),grossProfit=revenue-cogs,netProfit=grossProfit-variable-expenseTotal;const daily={};for(const o of orders){const p=dateParts(new Date(o.createdAtShopify),STORE_TZ),k=`${p.year}-${p.month}-${p.day}`;daily[k]??={date:k,revenue:0,profit:0};daily[k].revenue+=(o.netSales||0)+(o.shippingRevenue||0);daily[k].profit+=(o.netSales||0)+(o.shippingRevenue||0)-(o.cogs||0)-(o.shippingCost||0)-(o.paymentFees||0)-(o.materialCost||0)-(o.otherVariableCost||0);}for(const e of expenses){const k=new Date(e.date).toISOString().slice(0,10);daily[k]??={date:k,revenue:0,profit:0};daily[k].profit-=e.amount;}res.json({range:{start:r.startText,end:r.endText},kpis:{revenue,grossSales:sum('grossSales'),discounts:sum('discounts'),returns:sum('returns'),cogs,grossProfit,variableCosts:variable,operatingExpenses:expenseTotal,netProfit,orders:orders.length,aov:orders.length?revenue/orders.length:0,grossMargin:revenue?grossProfit/revenue*100:0,netMargin:revenue?netProfit/revenue*100:0},daily:Object.values(daily).sort((a,b)=>a.date.localeCompare(b.date)),recent:orders.sort((a,b)=>new Date(b.createdAtShopify)-new Date(a.createdAtShopify)).slice(0,8)});}));
app.get('/api/orders',asyncRoute(async(req,res)=>{const filter={};if(req.query.q)filter.$or=[{name:{$regex:req.query.q,$options:'i'}},{orderNumber:{$regex:req.query.q,$options:'i'}},{'lines.sku':{$regex:req.query.q,$options:'i'}}];const page=Math.max(1,+req.query.page||1),limit=50;res.json({items:await Order.find(filter).sort({createdAtShopify:-1}).skip((page-1)*limit).limit(limit).lean(),total:await Order.countDocuments(filter),page,limit});}));
app.get('/api/orders/:id',asyncRoute(async(req,res)=>{const item=await Order.findById(req.params.id).lean();if(!item)return res.sendStatus(404);res.json(item);}));
app.get('/api/pnl',asyncRoute(async(req,res)=>{const r=range(req.query),orders=await Order.find({createdAtShopify:{$gte:r.shopStart,$lte:r.shopEnd}}).lean(),expenses=await Expense.find({date:{$gte:r.ledgerStart,$lte:r.ledgerEnd}}).lean(),purchases=await Purchase.find({date:{$gte:r.ledgerStart,$lte:r.ledgerEnd}}).lean();const s=k=>orders.reduce((a,o)=>a+(o[k]||0),0),ps=k=>purchases.reduce((a,p)=>a+(p[k]||0),0);const rows=[['Gross sales',s('grossSales')],['Discounts',-s('discounts')],['Returns',-s('returns')],['Net product sales',s('netSales')],['Shipping revenue',s('shippingRevenue')],['Total revenue',s('netSales')+s('shippingRevenue')],['Cost of goods sold',-s('cogs')],['Gross profit',s('netSales')+s('shippingRevenue')-s('cogs')],['Shipping expense',-s('shippingCost')],['Payment processing',-s('paymentFees')],['Packing materials',-s('materialCost')],['Other variable costs',-s('otherVariableCost')]];const cats={};expenses.forEach(e=>cats[e.category||'Other']=(cats[e.category||'Other']||0)+e.amount);Object.entries(cats).forEach(([k,v])=>rows.push([k,-v]));const net=s('netSales')+s('shippingRevenue')-s('cogs')-s('shippingCost')-s('paymentFees')-s('materialCost')-s('otherVariableCost')-expenses.reduce((a,e)=>a+e.amount,0);rows.push(['Net profit',net]);const purchaseRows=[['PO / inventory purchases',ps('total')],['Inbound purchase shipping',ps('shipping')],['Duties & import costs',ps('duties')],['Purchase taxes',ps('tax')],['Tracked purchase outlay',ps('total')+ps('shipping')+ps('duties')+ps('tax')]];res.json({start:r.startText,end:r.endText,rows,net,purchaseRows,purchaseCount:purchases.length});}));
const __dirname=path.dirname(fileURLToPath(import.meta.url)),dist=path.join(__dirname,'../dist');if(process.env.NODE_ENV==='production'){app.use(express.static(dist));app.use((req,res,next)=>{if(req.method!=='GET'||req.path.startsWith('/api/')||req.path.startsWith('/auth')||req.path.startsWith('/webhooks/')||req.path==='/health')return next();res.sendFile(path.join(dist,'index.html'));});}app.use((err,req,res,next)=>{console.error(err);res.status(err.status||500).json({error:err.message||'Server error'});});
await mongoose.connect(process.env.MONGODB_URI);
await WebhookJob.init();
const refreshCatalog=async()=>{const s=shop();if(s&&await Session.exists({shop:s}))await syncCatalog(s)};
const maintainWebhooks=async()=>{const s=shop();if(s&&await Session.exists({shop:s}))return catalogWebhooks.ensure(s)};
const initializeCatalog=async()=>{try{await refreshCatalog();}finally{await maintainWebhooks();}};
initializeCatalog().catch(error=>console.error('Catalog initialization:',error.message));
setInterval(()=>refreshCatalog().catch(error=>console.error('Catalog sync:',error.message)),CATALOG_INTERVAL_MS).unref();
setInterval(()=>maintainWebhooks().catch(error=>console.error('Catalog webhooks:',error.message)),CATALOG_INTERVAL_MS).unref();
setInterval(()=>{const s=shop();if(s)catalogWebhooks.pump(s).catch(error=>console.error('Catalog webhook worker:',error.message));},2000).unref();
app.listen(port,'0.0.0.0',()=>console.log(`P&L server listening on ${port}`));
