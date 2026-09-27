# App Store Reviewer Testing Instructions — CatalogFlow

Thank you for reviewing **CatalogFlow: B2B Order Catalog**!

CatalogFlow allows Shopify merchants to create private wholesale order catalogs and receive bulk buyer submissions directly in Shopify as native Draft Orders.

---

## Step-by-Step Testing Guide

### 1. Install & Open Embedded App
1. Install **CatalogFlow: B2B Order Catalog** on your test store.
2. Open the app in Shopify Admin. Data synchronization will automatically sync your store's products and collections.

### 2. Create a Wholesale Catalog
1. Navigate to the **Catalogs** tab (or click **Create Catalog** on the Dashboard).
2. Click **+ Create Catalog**.
3. **Step 1 — Products/Collections**: Search and select at least one collection or product.
4. **Step 2 — Pricing**: Choose a pricing mode (e.g. *Percent Discount: 15%*).
5. **Step 3 — Rules & Settings**: Set catalog name (e.g. *"Summer Wholesale 2026"*), set minimum quantity or step increment if desired, check **Publish immediately after creation**, and click **Create & Publish Catalog**.

### 3. Share & Open Buyer Order Link
1. Once published, the **Your wholesale order link is ready** modal will appear.
2. Click **Copy Link** (or click **🔗 Open Buyer View ↗**).
3. Open the copied URL (`/c/:token` or `/l/:token`) in an incognito window. No buyer account or login is required!

### 4. Test Buyer Ordering Flow
1. As a buyer on the Wholesale Order Portal:
   - Select variant quantities using the quick-order interface.
   - Click **Review Wholesale Order** to open the order summary drawer.
   - Enter **Business Name** (e.g., *"Acme Traders"*) and **Business Email Address** (e.g., *"buyer@acmetraders.com"*).
   - Enter optional **PO Number** (e.g., *"PO-2026-901"*) and **Order Notes**.
   - Click **Submit Wholesale Order**.
2. A confirmation screen will display showing the order reference.

### 5. Verify Shopify Draft Order Creation
1. Return to your Shopify Admin → **Orders** → **Drafts**.
2. Verify that a new Draft Order was created containing:
   - The selected line items and quantities
   - The 15% B2B catalog discount applied
   - The buyer's email (`buyer@acmetraders.com`) attached
   - The PO Number and Business Name in tags / custom attributes.
3. In CatalogFlow, go to the **Submissions** tab to view the submission record and status.

### 6. Optional: Test Passcode Protection & QR Code
1. In CatalogFlow → **Catalogs** tab, click **Share Links** on any catalog.
2. Click **+ Create Order Link**, set a passcode (e.g. `1234`), and save.
3. Open the new link → verify buyer is prompted for a passcode before accessing the catalog.
