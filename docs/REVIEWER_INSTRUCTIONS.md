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

### 2. Create a Wholesale Catalog (3-Step Wizard)
1. Click the **Catalogs** tab in the top navigation.
2. Click **Create New Catalog** (or **Create Your First Catalog**).
3. The 3-step wizard opens:

   **Step 1 — Sources:**
   - Toggle between **Collections** and **Products** using the segmented tab.
   - Type in the search box to find Shopify collections or products by name. Results are loaded from your Shopify store's live Admin API.
   - Click any result row to select it (a ✓ checkmark appears). Selected sources appear as chips at the bottom.
   - You must select at least one source to proceed. The **Next →** button is disabled until a source is selected.

   **Step 2 — Pricing:**
   - Choose **Shopify Retail Price** (no modification) or **Catalog-Wide Wholesale Discount** (uniform % off retail).
   - If discount is selected, set the percentage (1–90%).

   **Step 3 — Details:**
   - Enter a **Catalog Name** (e.g., `Wholesale Spring 2026`).
   - Pick an **Accent Color** for the buyer portal branding.
   - Review the summary (sources count, pricing mode).
   - Optionally tick **Publish immediately after creation**.
   - Click **Create Draft** or **Create & Publish**.

4. Verify the catalog appears in the list with the correct status (DRAFT or PUBLISHED).

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
