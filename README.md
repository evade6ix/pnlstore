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

## Inventory catalog

`/inventory` lists one row per Shopify variant, including product image, title, SKU, price, Shopify unit cost, available stock, gross margin, and potential gross profit for all available units. The cards summarize the entire catalog, including drafts and archived products, independently of table filters/pagination. All amounts use the shop currency. Missing costs are flagged and excluded from known-cost profit calculations; untracked stock is excluded from valuation. Negative available quantities are displayed but valued at zero. Inventory costs use Shopify's current unit cost, while the existing effective-dated cost overrides remain specific to order COGS.

A complete paginated catalog sync runs on server startup, after OAuth, and hourly while the service runs. Shopify webhooks drive targeted catalog updates between full scans. New products, price/cost/stock/image changes, and product deletions are reconciled automatically. The Inventory page refreshes its saved data every 30 seconds. Use **Sync products** for an immediate catalog refresh or **Sync Shopify** for catalog plus orders. Catalog subscriptions are registered and verified automatically using the existing app connection. Catalog synchronization requires read access; editing products separately requires write access. The last successful sync and any sync failure are visible on the page. Imported orders remain independent of catalog deletions.

Inventory value = selling price × max(available quantity, 0). Inventory cost = Shopify unit cost × max(available quantity, 0). Gross margin = (price − unit cost) ÷ price × 100. Total potential gross profit = (price − unit cost) × max(available quantity, 0), before fees, shipping, discounts and tax.

Run `npm test` for inventory valuation, missing-cost handling, cursor pagination, concurrent sync deduplication, safe retry, and deletion reconciliation tests.

## Editing Shopify products

The Inventory table has an **Edit** action for each variant. The editor loads fresh Shopify values, supports price and unit cost, and shows available stock separately for each existing inventory location. **Save to Shopify** writes only changed fields using one `productVariantsBulkUpdate` mutation, then reads the saved Shopify values and refreshes the local catalog and totals. Quantity adjustments use `changeFromQuantity` so a concurrent order cannot be silently overwritten. Shopify errors leave the editor open; network-uncertain writes are never automatically retried.

Use **Enable Shopify editing** once in the browser to authorize the configured store and request `write_products` and `write_inventory` in addition to the configured read scopes. These write scopes must also be allowed for the app in Shopify’s Dev Dashboard. The OAuth callback sets an HttpOnly, Secure (production), signed owner cookie valid for 12 hours. Editor API routes require that cookie and the granted write scopes; PATCH requests additionally require the configured application origin and JSON content type. OAuth state is checked against a short-lived cookie and callbacks are restricted to `SHOPIFY_SHOP`. Opening the public inventory URL does not grant editing rights.

Existing order cost snapshots and manual COGS overrides are not modified by catalog edits. Inventory must already be tracked and stocked at a Shopify location to change its quantity.

### Missing editing permissions after reconnecting

A successful OAuth callback is not proof that write access was granted. The callback now queries `currentAppInstallation.accessScopes` and stores Shopify’s actual grants, then returns an explicit enabled / permissions-required result. Signed-in users without write grants see the missing scopes and instructions to update and release their app’s Shopify version, instead of a repeated enable button. **Check permissions again** refreshes actual grants without restarting OAuth and is restricted to the signed owner session and application origin. If the app is configured through Shopify’s Dev Dashboard, add `write_products` and `write_inventory` to a new version, release it, and approve the update in Shopify admin. Keep existing scopes when updating the app.

## Automatic catalog webhooks

On startup and after OAuth, the server registers and verifies nine shop-scoped subscriptions at `SHOPIFY_APP_URL/webhooks/catalog`: products create/update/delete; inventory items create/update/delete; inventory levels update/connect/disconnect. It rechecks the subscriptions hourly and preserves subscriptions at other destinations. No separate Dev Dashboard webhook setup is required. Existing product/inventory scopes authorize these subscriptions.

The receiver checks the raw-body HMAC and configured shop, validates resource IDs, and durably upserts a MongoDB job using Shopify’s webhook delivery ID before acknowledging. A unique index makes duplicate deliveries harmless. The background worker claims jobs with expiring leases, retries failures with backoff, and retains completed jobs for seven days for deduplication. Pending jobs survive deployments.

Product events refresh every variant of the affected product using fresh Shopify state; stock and cost events resolve the inventory item to its product. This avoids relying on event ordering or truncated payloads. Unknown new inventory items trigger a full recovery scan. Full scans and targeted refreshes share a per-shop queue to avoid stale scans overwriting newer data. Deleted products/variants disappear from the catalog without removing historical orders.

The five-minute full polling loop is replaced by an hourly full backup, while manual sync and direct editing remain available. The Inventory page continues to refresh saved data every 30 seconds and shows webhook registration, errors, queued work, and last processed event. Webhook subscriptions and worker failures are visible through the `webhooks` / `pendingWebhooks` fields of `/api/inventory`.

## Editing financial records

Expenses, purchases/POs, and effective-dated product cost overrides have searchable tables with prefilled Edit forms. Expense edits include date, vendor, category, amount, tax, reference, description, recurring label and notes. Purchase edits include supplier, date, PO number, status, goods amount, freight, duties, tax and notes, with a total-outlay preview. Tax on operating expenses remains separate from the P&L expense amount.

Manual sales support multiple items, quantities, SKU/variant labels, line sales totals, discounts, unit costs, shipping charged, taxes, fulfilment/payment costs and notes. Existing manual sales retain their identity and order number when edited. Sales and COGS totals are calculated on the server; subsequent dashboard and P&L requests use the saved records. Orders have editable per-line unit costs and fulfilment costs. Shopify-origin products, discounts and sale status are edited through the order’s Open in Shopify link.

Financial mutations require the signed Shopify owner session, the configured application origin and JSON. Updates and deletions include the version loaded by the editor (`expectedUpdatedAt`); a stale version returns HTTP 409 instead of overwriting another save. The API validates and allowlists fields, and rejects invalid dates, quantities and costs. Deleting a financial record requires confirmation in the UI.

Shopify reimports preserve each existing order line’s saved historical unit cost, including zero costs and order-specific corrections. Import updates also guard the order version and retry if an edit races a sync. Editing a cost override affects future imported order lines; correct existing sales directly through their order costs. Catalog costs and inventory quantities continue to be edited separately through Shopify.

Run `npm test` for ledger validation, derived financial totals, authenticated HTTP updates, stale-write protection, historical snapshots, and existing inventory/webhook checks.
