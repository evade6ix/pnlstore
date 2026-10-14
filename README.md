# Ledgerly — Go Next Hobbies P&L

Private full-stack commerce finance suite. React/Vite frontend + Express/Mongoose API in one deployable Railway service.

## Local setup

```bash
cp .env.example .env
npm install
npm run dev
```

Vite runs on 5173 and proxies API/auth traffic to the Express server on 3000.

## Railway

Deploy this repository as one service. Build command: `npm run build`. Start command: `npm start`.

Set these Railway variables (never commit secrets):

- `NODE_ENV=production`
- `MONGODB_URI` — use Railway's private MongoDB connection string when both services are in the same project/environment.
- `SHOPIFY_CLIENT_ID`
- `SHOPIFY_CLIENT_SECRET`
- `SHOPIFY_SHOP` — `your-store.myshopify.com`
- `SHOPIFY_APP_URL` — the public HTTPS URL of this Railway service, no trailing slash
- `SHOPIFY_SCOPES=read_orders,read_products,read_inventory,read_locations,read_returns,read_shopify_payments_accounts,read_shopify_payments_payouts,read_shopify_payments_disputes`
- `SHOPIFY_API_VERSION=2026-10`

In Shopify Dev Dashboard set App URL to `SHOPIFY_APP_URL` and allowed redirect URL to `SHOPIFY_APP_URL/auth/callback`.

## Finance model

Shopify orders are copied into MongoDB and retained. Each line stores a historical unit-cost snapshot. Cost overrides are effective-dated. Manual sales, order-level shipping/payment/material costs, operating expenses and purchase orders are first-class records. The P&L is calculated from the local ledger rather than Shopify Analytics.

## Important accounting behavior

Purchase orders are tracked as cash/procurement records but are not automatically expensed in the P&L, because inventory purchases normally become COGS as units sell. This avoids double-counting inventory cost. Operating expenses are included directly in the P&L.

## Webhooks

The server exposes `POST /webhooks/orders` with Shopify HMAC validation. Register order create/update/refund webhooks against that endpoint after installation. Manual `Sync Shopify` imports the accessible order history and upserts it safely.
