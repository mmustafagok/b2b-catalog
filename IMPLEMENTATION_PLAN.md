# IMPLEMENTATION PLAN: B2B Catalog / Buyer Order Portal for Shopify

> **Production Application Specification & Architecture**  
> **Source of Truth:** `B2B_Catalog_Buyer_Order_Portal_Production_Docs_TR.docx`  
> **Working Title:** CatalogFlow: B2B Order Catalog (Safe Catalog)  
> **Status:** Phase 0 Completed — Ready for Architectural Review & Execution  

---

## 1. Executive & Strategic Summary

### 1.1 Core Product Wedge
A focused, high-speed B2B ordering surface for Shopify merchants:
$$\text{Shopify Products} \longrightarrow \text{Live Wholesale Catalog Link} \longrightarrow \text{Bulk Variant / Qty Matrix} \longrightarrow \text{Submit} \longrightarrow \text{Submit-Time Revalidation} \longrightarrow \text{Shopify Draft Order}$$

- **The catalog is not a static PDF or aesthetic brochure:** It is an interactive **order collection surface**.
- **The product sold:** Frictionless B2B order capture without requiring buyer login or account creation.
- **Shopify is the System of Record:** Products, variants, inventory, and Draft Orders belong to Shopify. No shadow financial orders or duplicate pricing engines.

### 1.2 Target Merchant & ICP
- **Profile:** Small-to-midsize Shopify merchants selling wholesale/B2B (apparel, accessories, beauty, food & beverage wholesale, decor, parts).
- **Scale:** 30–5,000 SKUs/variants; 10–500 recurring B2B buyers/resellers/retailers/sales reps.
- **Pain Solved:** Replaces error-prone manual order entry from PDFs, Excel sheets, emails, and WhatsApp messages into Shopify Admin. Eliminates stale pricing surprises and out-of-stock complaints.
- **North Star Metric:** `draft_order_created_from_buyer_submission`. Activation defined as publishing a live catalog link and creating a test Draft Order in under 10 minutes.

### 1.3 Strict Scope Boundaries (Non-Goals)
To prevent scope creep and maintain reliability:
- **NO** Canva-like freeform visual drag-and-drop page builder.
- **NO** 50+ templates or arbitrary custom CSS injection.
- **NO** complex customer-specific contract pricing engine (Shopify native B2B territory).
- **NO** custom payment gateways, invoicing, or AR/AP systems.
- **NO** PDF linesheet export in V1 (reserved for P1).
- **NO** buyer login / account registration requirement.
- **NO** CSV/PO bulk file upload in V1 (P1).

---

## 2. Technical Architecture & Tech Stack

```
+-----------------------------------------------------------------------------------------+
|                                    SHOPIFY PLATFORM                                     |
|  - GraphQL Admin API 2026-07 (Products, Variants, Draft Orders, Webhooks, Billing)      |
|  - Mandatory Privacy Webhooks (customers/data_request, customers/redact, shop/redact)   |
+-----------------------------------------------------------------------------------------+
                                 ▲                                   ▲
               Embedded App Auth | (GraphQL / HMAC)                  | GraphQL
                                 ▼                                   ▼
+----------------------------------------------------+   +--------------------------------+
|           MERCHANT EMBEDDED ADMIN                  |   |      PUBLIC BUYER PORTAL       |
|  - Shopify App Bridge + React Router / Remix       |   |  - Fast, responsive web UI     |
|  - Polaris Design System Components                |   |  - URL: /c/:publicToken        |
|  - Wizard: Sources -> Pricing -> Brand & Publish   |   |  - Search & Collection Filter  |
|  - Submissions History & Draft Order Deep Links    |   |  - Variant Quantity Matrix     |
|  - Quota & Billing Management                      |   |  - Sticky Order Summary & Cart |
+----------------------------------------------------+   +--------------------------------+
                          │                                              │
                          │                                              │ POST /submit
                          ▼                                              ▼ (Idempotency-Key)
+-----------------------------------------------------------------------------------------+
|                                APPLICATION BACKEND                                      |
|  - Node.js (TypeScript) + React Router / Express / Remix Server Engine                  |
|  - Services Layer:                                                                      |
|      * auth.server.ts          -> OAuth, offline sessions, App Bridge token verify     |
|      * catalog.server.ts       -> Catalog CRUD, source resolution, snapshot generator   |
|      * sync.server.ts          -> Initial sync & webhook-driven snapshot updates        |
|      * pricing.server.ts       -> Deterministic price calculation (Base vs % Discount)  |
|      * revalidation.server.ts  -> Submit-time GraphQL verification against Shopify      |
|      * draft-order.server.ts   -> Draft Order creation with appliedDiscount & attributes|
|      * idempotency.server.ts   -> SHA-256 key hashing, transactional deduplication     |
|      * billing.server.ts       -> Plan enforcement (Starter, Growth, Scale), hard caps  |
|      * privacy.server.ts       -> Log sanitization, non-PII DB storage, privacy webhooks|
+-----------------------------------------------------------------------------------------+
                                              │
                                              ▼
+-----------------------------------------------------------------------------------------+
|                                  DATA PERSISTENCE                                       |
|  - Prisma ORM + PostgreSQL (with SQLite compatibility for fast local tests)             |
|  - Normalized cache snapshots: ProductSnapshot, VariantSnapshot, CatalogSource          |
|  - Business records: Shop, Catalog, OrderSubmission (Zero Raw Buyer PII), WebhookReceipt|
+-----------------------------------------------------------------------------------------+
```

---

## 3. Database Entities & Data Model

### 3.1 Entity Specifications

#### `Shop`
- `id`: String (UUID, PK)
- `shopDomain`: String (Unique, e.g. `merchant.myshopify.com`)
- `accessToken`: String (Encrypted offline session token)
- `plan`: Enum (`STARTER` | `GROWTH` | `SCALE`), default `STARTER`
- `billingCycleAnchor`: DateTime
- `monthlySubmissionsCount`: Int, default 0
- `installedAt`: DateTime, default `now()`
- `uninstalledAt`: DateTime? (Null if active)
- *Indexes:* `shopDomain`, `uninstalledAt`

#### `Catalog`
- `id`: String (UUID, PK)
- `shopId`: String (FK -> `Shop.id`, cascade delete)
- `name`: String
- `publicToken`: String (Unique, 128-bit cryptographically secure URL-safe token)
- `status`: Enum (`DRAFT` | `PUBLISHED` | `ARCHIVED`), default `DRAFT`
- `priceMode`: Enum (`SHOPIFY_PRICE` | `PERCENT_DISCOUNT`), default `SHOPIFY_PRICE`
- `discountPercent`: Decimal? (0.00 to 90.00)
- `logoUrl`: String?
- `accentColor`: String? (Hex, e.g. `#108043`)
- `showSku`: Boolean, default true
- `showInventory`: Boolean, default false
- `dataVersion`: Int, default 1 (Incremented on catalog changes or product updates)
- `publishedAt`: DateTime?
- `createdAt`: DateTime, default `now()`
- `updatedAt`: DateTime, updated on modification
- *Indexes:* `shopId`, `publicToken`, `status`

#### `CatalogSource`
- `id`: String (UUID, PK)
- `catalogId`: String (FK -> `Catalog.id`, cascade delete)
- `type`: Enum (`COLLECTION` | `PRODUCT`)
- `shopifyGid`: String (e.g. `gid://shopify/Collection/12345` or `gid://shopify/Product/67890`)
- *Indexes:* `catalogId`, `shopifyGid`

#### `ProductSnapshot` (Read-Optimized Cache)
- `id`: String (UUID, PK)
- `shopId`: String (FK -> `Shop.id`, cascade delete)
- `shopifyProductId`: String (e.g. `gid://shopify/Product/123`)
- `title`: String
- `vendor`: String?
- `handle`: String
- `imageUrl`: String?
- `status`: String (ACTIVE, DRAFT, ARCHIVED)
- `sourceUpdatedAt`: DateTime?
- `syncedAt`: DateTime, default `now()`
- *Indexes:* `[shopId, shopifyProductId]`, `shopId`

#### `VariantSnapshot` (Read-Optimized Cache)
- `id`: String (UUID, PK)
- `shopId`: String (FK -> `Shop.id`, cascade delete)
- `shopifyVariantId`: String (e.g. `gid://shopify/ProductVariant/456`)
- `shopifyProductId`: String
- `title`: String
- `sku`: String?
- `barcode`: String?
- `shopifyPrice`: Decimal
- `inventoryQuantity`: Int, default 0
- `availableForSale`: Boolean, default true
- `selectedOptionsJson`: String (JSON representation of option name/value pairs)
- `imageUrl`: String?
- `sourceUpdatedAt`: DateTime?
- `syncedAt`: DateTime, default `now()`
- *Indexes:* `[shopId, shopifyVariantId]`, `[shopId, shopifyProductId]`, `sku`

#### `OrderSubmission` (Zero Raw Buyer PII)
- `id`: String (UUID, PK)
- `shopId`: String (FK -> `Shop.id`, cascade delete)
- `catalogId`: String (FK -> `Catalog.id`, cascade delete)
- `draftOrderId`: String (Shopify GID: `gid://shopify/DraftOrder/789`)
- `draftOrderName`: String? (e.g. `#D1001`)
- `idempotencyKeyHash`: String (SHA-256 of publicToken + client idempotency key)
- `itemCount`: Int
- `lineCount`: Int
- `subtotalAmount`: Decimal
- `currency`: String
- `createdAt`: DateTime, default `now()`
- *Crucial PII Rule:* **NO raw email or street address stored here**. Email is passed directly into Shopify Draft Order.
- *Indexes:* `[shopId, catalogId]`, `draftOrderId`, `[catalogId, idempotencyKeyHash]` (Unique)

#### `SyncRun`
- `id`: String (UUID, PK)
- `shopId`: String (FK -> `Shop.id`, cascade delete)
- `type`: Enum (`INITIAL` | `MANUAL` | `WEBHOOK`)
- `status`: Enum (`PENDING` | `IN_PROGRESS` | `COMPLETED` | `FAILED`)
- `statsJson`: String? (e.g. `{"productsSynced": 120, "variantsSynced": 480}`)
- `startedAt`: DateTime, default `now()`
- `finishedAt`: DateTime?

#### `WebhookReceipt`
- `id`: String (UUID, PK)
- `webhookId`: String (Unique, Shopify webhook X-Shopify-Webhook-Id header)
- `topic`: String
- `shopDomain`: String
- `processedAt`: DateTime, default `now()`
- *Indexes:* `webhookId`

---

## 4. Route & Screen Map

### 4.1 Merchant Embedded Admin Routes (Shopify App Bridge)
1. `/app` — **Dashboard**:
   - High-level KPIs: Active Catalogs, Monthly Submissions, Submissions vs. Quota, Sync Health.
   - Primary CTA: "Create your first catalog" (Empty state) or "Create new catalog".
   - Recent Submissions table with status and Shopify Draft Order deep-links.
2. `/app/catalogs` — **Catalog List**:
   - Table of catalogs (Name, Status badge [Draft/Published/Archived], Included Products count, Price Mode, Public Link copy button, Actions).
3. `/app/catalogs/new` — **Create Wizard**:
   - Step 1: Select Inventory (Collection picker / Product picker with search and counts).
   - Step 2: Pricing (Shopify Price vs. % Discount, live preview of 3 sample items).
   - Step 3: Brand & Settings (Catalog Name, Logo upload/URL, Accent color, Show SKU toggle, Show Inventory toggle).
   - Action: "Save as Draft" or "Publish Catalog".
4. `/app/catalogs/:id` — **Catalog Detail & Editor**:
   - Edit sources, pricing, branding.
   - Publish / Unpublish / Archive toggle.
   - Direct copyable public URL with one-click clipboard action.
   - Sync status indicator and "Force Resync" button.
5. `/app/submissions` — **Submissions History**:
   - Log of all buyer submissions across catalogs.
   - Columns: Date/Time, Catalog Name, Items/Lines, Subtotal, Draft Order ID & Direct Deep Link into Shopify Admin.
6. `/app/settings/billing` — **Plans & Billing**:
   - Current plan card, trial countdown, usage progress bars (Catalogs used / Submissions used this month).
   - Upgrade / Downgrade actions targeting Shopify App Billing API.

### 4.2 Public Buyer Portal Routes (No-Login)
1. `GET /c/:publicToken` — **Buyer Catalog Page**:
   - Responsive, keyboard-friendly ordering UI.
   - Header: Merchant logo, catalog title, search bar (SKU / title), collection dropdown filter.
   - Product Grid / Table: Variant matrix (Color x Size matrix or variant list with instantaneous numerical quantity inputs).
   - Sticky Order Bar: Total items, estimated subtotal, and "Review Order" drawer trigger.
2. `GET /api/public/catalog/:publicToken` — **Catalog Data Endpoint**:
   - Returns: Catalog branding, active collections, products with variants, cached display prices, and current `dataVersion`.
3. `POST /api/public/catalog/:publicToken/validate` — **Pre-submit Validation**:
   - Payload: `{ dataVersion, lines: [{ variantId, qty }] }`.
   - Returns: `{ status: "VALID" | "CHANGED" | "INVALID", changes: [...] }`.
4. `POST /api/public/catalog/:publicToken/submit` — **Order Submission**:
   - Headers: `Idempotency-Key: <UUID>`
   - Payload: `{ dataVersion, lines: [{ variantId, qty }], buyer: { businessName, email, poNumber, note } }`
   - Returns:
     - `201 Created`: `{ submissionId, draftOrderId, referenceNumber, subtotalAmount, currency }`
     - `409 Conflict`: `{ code: "CATALOG_CHANGED", message: "...", changedLines: [...] }`
     - `422 Unprocessable Entity`: `{ code: "INVALID_LINES", errors: [...] }`
     - `429 Too Many Requests`: Rate limit exceeded or monthly quota reached.

---

## 5. Shopify API Interactions & Financial Boundaries

### 5.1 Scopes Required (GraphQL Admin API 2026-07)
- `read_products`: Read product titles, handles, options, images, and prices.
- `read_inventory`: Optional/Recommended for inventory signals if merchant enables `showInventory`.
- `write_draft_orders`: Create Draft Orders from verified buyer submissions.
- `read_draft_orders`: Verify created Draft Order status and deep linking.

### 5.2 Submit-Time Revalidation Flow (Safe Ordering Boundary)
The buyer catalog relies on DB snapshots for sub-second page loads. However, the browser is **never trusted** with price, availability, or variant existence.
```
Buyer clicks "Submit Order"
       │
       ▼
1. Validate incoming JSON payload with Zod schema (quantities >= 1, valid GID format, valid email).
2. Check Catalog status (must be PUBLISHED; shop must not be uninstalled).
3. Query Shopify Admin GraphQL `productVariants` for the exact subset of selected variant GIDs.
       │
       ├── Any variant not found or deleted? ──► Abort -> Return 422 with missing variant IDs.
       ├── Any variant not `availableForSale`? ──► Abort -> Return 409 with out-of-stock items.
       └── Re-compute wholesale price:
             expectedPrice = baseShopifyPrice * (1 - catalog.discountPercent / 100)
             Did Shopify price change compared to buyer snapshot?
             ──► Abort -> Return 409 CATALOG_CHANGED with oldPrice vs newPrice.
       │
All lines match Shopify reality!
       ▼
Proceed to Idempotent Draft Order Creation.
```

### 5.3 Idempotency & Concurrency Mechanism
- The client sends an `Idempotency-Key: <UUID>` header.
- The server generates `idempotencyKeyHash = SHA-256(publicToken + ":" + idempotencyKey)`.
- Inside a serializable / atomic database transaction:
  1. Check if `OrderSubmission` exists with `idempotencyKeyHash`.
  2. If exists, return cached submission details immediately with HTTP `200 OK` (no duplicate Draft Order created).
  3. If not exists, insert a reservation row or lock.
- Call Shopify GraphQL `draftOrderCreate`:
  ```graphql
  mutation draftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        name
        status
        totalPrice
      }
      userErrors {
        field
        message
      }
    }
  }
  ```
  - `input.lineItems`: Array of `{ variantId, quantity, appliedDiscount?: { value, valueType: "PERCENTAGE" } }`.
  - `input.email`: `buyer.email` (passed directly to Shopify, never stored in DB).
  - `input.note`: `buyer.note`.
  - `input.customAttributes`:
    - `{ key: "PO Number", value: buyer.poNumber }`
    - `{ key: "Business Name", value: buyer.businessName }`
    - `{ key: "Catalog", value: catalog.name }`
    - `{ key: "Submission Reference", value: submissionId }`
  - `input.tags`: `["b2b-catalog", "catalog-flow"]`
- Store `OrderSubmission` record (with `draftOrderId`, `subtotalAmount`, `itemCount`, etc., strictly omitting buyer email/address).
- Commit transaction and return `201 Created` with confirmation reference.

---

## 6. Security, Privacy & Compliance Model

### 6.1 Multi-Tenant Isolation
- Every merchant query enforces `where: { shopId: authenticatedShopId }`.
- Catalogs, submissions, and sync snapshots cannot be accessed across shops.
- Unit and integration tests explicitly verify cross-tenant denial.

### 6.2 Buyer PII Minimization & Logging Safety
- In compliance with Shopify App Store requirements:
  - Buyer raw email and physical address are **NOT persisted** in the application database.
  - The email is handed directly to Shopify in the `draftOrderCreate` mutation.
  - The local database stores only non-PII aggregate data (item count, subtotal, currency, timestamp, Shopify Draft Order GID).
- Structured logging: All logs pass through a sanitizer that redacts:
  - Emails (`*@*.*`)
  - Tokens and OAuth codes
  - Shopify session secrets and HMAC headers
  - Credit card numbers / personal identification

### 6.3 Public Surface Protection
- `publicToken` is generated using `crypto.randomBytes(32).toString('hex')` (256-bit entropy, impossible to enumerate).
- Inactive or uninstalled shop catalogs immediately return `404 Not Found`.
- Honeypot hidden fields and in-memory rate limiting per IP / token on `/api/public/catalog/:publicToken/submit`.

### 6.4 Mandatory Shopify Webhooks
- `app/uninstalled`: Marks shop `uninstalledAt = now()`, revokes credentials, disables all public catalog links immediately.
- `customers/data_request`: Returns acknowledged receipt (no buyer customer PII stored).
- `customers/redact`: Returns 200 OK (no buyer PII retained).
- `shop/redact`: Deletes shop data according to retention schedule (48 hours post-uninstall).
- All webhooks verified using Shopify HMAC SHA-256 header validation.

---

## 7. Pricing, Packaging & Quota Enforcement

### 7.1 Subscription Tiers (Shopify App Billing API)
| Plan | Price | Live Catalogs | Variant Limit | Monthly Submissions | Trial |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Starter** | $14.99/mo | 1 | 500 variants | 50 submissions/mo | 7 Days |
| **Growth** | $29.99/mo | 5 | 5,000 variants | 250 submissions/mo | 7 Days |
| **Scale** | $49.99/mo | 20 | 25,000 variants | 1,000 submissions/mo | 7 Days |

- **No surprise overage fees:** Hard quota caps with clear upgrade prompts in Admin.
- If quota is exceeded, order submission endpoint returns a clear, polite error to the buyer and sends a notification alert to the merchant.

---

## 8. Milestone Sequence (10 Production-Complete Milestones)

- **M0: Spec & Repo Audit + Implementation Plan** (Current Phase)
  - Full audit of `B2B_Catalog_Buyer_Order_Portal_Production_Docs_TR.docx`.
  - Architecture blueprint, data model, security strategy, and approval gate.
- **M1: Foundation & Shop Lifecycle**
  - Git repository initialization, `.gitignore`, TypeScript, Prisma schema & migrations.
  - Shopify OAuth, session storage, install / reinstall / uninstall lifecycle handling.
  - Baseline healthcheck and quality gates.
- **M2: Merchant Catalog Domain & CRUD**
  - Catalog management backend & Polaris Admin UI.
  - 3-step creation wizard (Inventory selection, Pricing mode, Branding).
  - Draft vs. Published state management and multi-tenant isolation.
- **M3: Product Sync & Public Catalog Engine**
  - Shopify GraphQL product & variant fetcher.
  - Real-time webhooks (`products/create`, `products/update`, `products/delete`) for cache freshness.
  - Fast public catalog retrieval API (`/api/public/catalog/:publicToken`).
- **M4: Buyer Ordering Surface & UX**
  - Modern, responsive wholesale catalog page (`/c/:publicToken`).
  - Sub-250ms search & collection filtering.
  - Keyboard-friendly variant matrix for rapid quantity input.
  - Sticky order summary drawer with live recalculation.
- **M5: Submit-Time Revalidation, Draft Order & Idempotency**
  - Server-side Zod validation and Shopify GraphQL variant re-fetcher.
  - Stale price & out-of-stock detection with `409 Conflict` review flow.
  - Idempotent `draftOrderCreate` mutation with line items, tags, PO attributes.
- **M6: Merchant Operations & Submissions History**
  - Submissions history table with direct deep-links to Shopify Draft Orders.
  - Sync health diagnostics and manual "Force Resync" capability.
- **M7: App Billing, Quotas & Entitlements**
  - Shopify App Billing API integration for Starter, Growth, and Scale plans.
  - 7-day trial flow, quota tracking, and non-destructive upgrade triggers.
- **M8: Security Hardening, Webhooks & Privacy Compliance**
  - HMAC webhook verification with deduplication.
  - Mandatory GDPR/privacy compliance endpoints (`customers/redact`, `shop/redact`).
  - Structured log sanitizer and rate limiting.
- **M9: Edge Cases, Error Boundaries & UX Polish**
  - Comprehensive handling for Shopify API rate limits, network timeouts, deleted collections, and uninstalled shops.
  - Empty states, loading skeletons, and inline error feedback.
- **M10: Comprehensive Test Suite, App Store Readiness & Launch Checklist**
  - Automated unit, integration, and tenant isolation test suites.
  - Production build verification, typechecks, and deployment documentation.

---

## 9. Automated Testing & Verification Strategy

The test suite will cover the critical paths outlined in the specification:
1. **Auth & Lifecycle:** Install, re-install, uninstall token deactivation.
2. **Multi-Tenant Isolation:** Verify Shop A cannot access Shop B's catalogs or submissions.
3. **Pricing Calculations:** Base Shopify price, 0%, 10%, 33.3%, 90% discount rounding semantics.
4. **Submit-Time Revalidation:**
   - Detect deleted variant -> return `422`.
   - Detect out-of-stock variant -> return `409`.
   - Detect changed Shopify base price -> return `409` with updated lines.
5. **Idempotency & Concurrency:**
   - Rapid double submission with same key -> exactly 1 Draft Order created.
   - Distinct keys -> 2 distinct Draft Orders.
6. **PII Safety:** Assert zero buyer emails or physical addresses saved in the database.
7. **Webhook HMAC:** Valid HMAC processes cleanly; invalid HMAC rejects with 401.

---

## 10. Questions / Blockers Check
- All core requirements, data structures, workflows, and edge cases are clearly defined in `B2B_Catalog_Buyer_Order_Portal_Production_Docs_TR.docx`.
- **No blocking ambiguities exist.** Minor technical choices (e.g. using SHA-256 for idempotency key hashing, 256-bit crypto tokens for URLs) follow established production security best practices.
