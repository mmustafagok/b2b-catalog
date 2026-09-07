# CatalogFlow — Shopify Reviewer Testing Instructions

## Overview
**App Name:** CatalogFlow: B2B Order Catalog  
**Core Wedge:** Turn Shopify products into live wholesale ordering catalogs that generate native Shopify Draft Orders.

---

## Prerequisites & Access
- **No External Hardware Required:** The entire workflow runs in modern web browsers.
- **No External Accounts or Third-Party Credentials Required:** CatalogFlow authenticates seamlessly through Shopify Admin using standard App Bridge session tokens and Managed Installation.
- **No Buyer Login Required:** Wholesale buyer catalogs use secure, unlisted, opaque public tokens (`/c/:publicToken`).

---

## Step-by-Step Review Verification Flow

### 1. Embedded App Load & Initialization
1. In Shopify Admin, open **Apps** and click **CatalogFlow: B2B Order Catalog**.
2. Verify the embedded admin app opens seamlessly without redirection outside Shopify Admin.
3. Confirm that CatalogFlow initiates an automated initial sync, creating snapshots of the store's active products, variants, and collections.

### 2. Create a Wholesale Catalog
1. Click the **Catalogs** tab in the top navigation.
2. Click **Create New Catalog**.
3. Fill in the catalog details:
   - **Catalog Name:** e.g., `Wholesale Spring 2026`
   - **Price Mode:** Select **Wholesale % Discount Mode** (e.g., `20% Off`).
   - **Catalog Sources:** Select one or more products or collections.
   - **Display Options:** Check **Show SKU** and **Show Inventory Count**.
4. Click **Save & Publish Catalog**.
5. Verify the catalog status transitions to **PUBLISHED** and a public buyer link is generated.

### 3. Open Wholesale Buyer Portal
1. Click **Copy Buyer Link** (or click **Open Buyer Portal ↗**).
2. Open the copied URL in a new browser window or Incognito window (e.g., `https://<domain>/c/<token>`).
3. Notice:
   - No login or password required.
   - Branded wholesale header with store name and catalog title.
   - Search bar filtering by title, SKU, or vendor in real time.
   - Responsive variant matrix displaying available sizes/colors with wholesale discounted pricing.

### 4. Enter Quantities & Submit an Order
1. Enter quantities across several variants (e.g., 5 of Size M, 10 of Size L, 12 of another item).
2. Observe the sticky bottom **Order Summary Bar** updating line count, total items, and subtotal in real time.
3. Click **Review & Submit Order**.
4. In the order review modal, provide:
   - **Buyer Email:** `buyer@acme-retail.com`
   - **Business Name:** `Acme Wholesale Retailers Ltd.`
   - **Purchase Order (PO) Number:** `PO-2026-9941`
   - **Order Notes:** `Please ship via freight dock B.`
5. Click **Submit Wholesale Order**.
6. Verify instant order confirmation displaying the confirmation reference number.

### 5. Verify Native Shopify Draft Order Creation
1. Return to **Shopify Admin** $\rightarrow$ **Orders** $\rightarrow$ **Drafts**.
2. Open the newly created Draft Order:
   - **Items & Quantities:** Verify all selected variants and quantities match.
   - **Applied Discount:** Verify the configured 20% discount is applied to line items.
   - **Customer Email & Tags:** Note the buyer email and CatalogFlow correlation tags (e.g., `cf-b2b`, `cf-sub:<id>`).
   - **Order Notes:** Verify the PO number and buyer delivery notes are attached.
3. In CatalogFlow Merchant Admin, click the **Submissions** tab to verify the order is recorded with deep links directly to the Shopify Draft Order.

### 6. Test Stale Catalog Protection (Revalidation)
1. Keep the buyer portal open.
2. In Shopify Admin, change a product's price or set its inventory/status to draft.
3. Submit an order from the previously loaded buyer portal.
4. Verify the buyer is presented with a clear notice that catalog data has changed (`409 CATALOG_CHANGED`), preventing underpriced or unavailable orders from being created.
