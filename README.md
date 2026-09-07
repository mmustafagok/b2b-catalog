# CatalogFlow: B2B Order Catalog for Shopify

> **Official B2B Wholesale Catalog & Fast Buyer Order Portal for Shopify**  
> Direct Shopify integration that allows merchants to share digital wholesale catalogs where approved buyers rapidly submit variant quantities, generating native Shopify Draft Orders.

---

## 1. Product Architecture

CatalogFlow follows the official Shopify Embedded App architecture with a dual-surface model:

1. **Merchant Embedded Admin (Shopify App Bridge & Polaris):**
   - Embedded directly within the merchant's Shopify Admin.
   - 3-step catalog wizard: Select inventory sources, configure deterministic pricing, and customize brand identity.
   - Synchronized product snapshots and catalog health diagnostics.
   - Submissions history linked directly to native Shopify Draft Orders.
2. **Public Buyer Ordering Portal (`/c/:publicToken`):**
   - High-speed, responsive, no-login ordering interface designed for wholesale buyers.
   - Sub-250ms instant client-side search by title, SKU, and vendor.
   - Multi-variant quantity matrix (+/- buttons and direct keyboard numerical inputs).
   - Sticky real-time order summary bar with localized currency rendering.
   - Modal drawer capturing business information, email, optional PO number, and delivery notes.

---

## 2. Technology Stack

- **Runtime:** Node.js (v20+ / v22+) & TypeScript
- **Database:** PostgreSQL (with Prisma ORM and dedicated SQL migrations)
- **Shopify Integration:** GraphQL Admin API `2026-07`
- **Frontend:** React, Vite, Shopify Polaris
- **Security:** AES-256-GCM authenticated encryption at rest for access tokens, HMAC SHA-256 webhook validation, JWT claim verification (aud, iss, dest, exp).
- **Test Suite:** Vitest (41 unit and integration test cases)

---

## 3. Database & PostgreSQL Setup

CatalogFlow relies on PostgreSQL for production relational integrity, strict multi-tenant isolation, and atomic concurrency guards.

### Environment Configuration (`.env`)
```bash
# PostgreSQL Connection Strings
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/catalogflow?schema=public"
TEST_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/catalogflow_test?schema=public"

# Session & Token Encryption (32-byte secret)
ENCRYPTION_SECRET="at_least_32_characters_random_hex_secret_here"

# Shopify App Credentials
SHOPIFY_API_KEY="your_shopify_api_key"
SHOPIFY_API_SECRET="your_shopify_api_secret"
SCOPES="read_products,read_inventory,write_draft_orders,read_draft_orders"
HOST="http://localhost:8080"
PORT=8080
NODE_ENV="development"
```

### Running Migrations
```bash
# Apply migrations to production database
npm run prisma:deploy

# Generate Prisma Client
npm run prisma:generate

# In development, create new migrations
npm run prisma:migrate
```

---

## 4. Shopify Lifecycle & Synchronization

### 4.1 Installation & Authentication
1. **OAuth Initiation (`/auth/shopify`):** Initiates Shopify OAuth with scopes `read_products,read_inventory,write_draft_orders,read_draft_orders`.
2. **Callback (`/auth/callback`):**
   - Validates query HMAC signature.
   - Exchanges authorization code for permanent offline access token.
   - Encrypts access token at rest using AES-256-GCM.
   - Ingests shop metadata and primary currency.
   - Automatically triggers initial catalog synchronization.

### 4.2 Initial Product & Collection Sync
- A newly installed merchant's products are immediately synced via the centralized `ShopifyAdminClient` using GraphQL Admin API `2026-07`.
- Sync runs in the background with cursor pagination (`products`, `collections`, `variants`).
- Normalized into `ProductSnapshot`, `VariantSnapshot`, and `CollectionProductMembership`.
- Sync status and counts are audited in `SyncRun`.

### 4.3 Exact Collection Membership Resolution
- When a catalog sources a Shopify Collection, it resolves **only** the products that belong to that specific collection via `CollectionProductMembership`.
- Mixed sources (e.g. Collection A + explicit Product C) are unioned without duplicates.
- Product removal from collections in Shopify automatically updates resolved catalog contents.

### 4.4 Hardened & Idempotent Webhooks
- Webhook endpoints fail closed: any request with missing secrets or invalid HMAC is rejected with `401 Unauthorized`.
- Deduplication is guaranteed via `WebhookReceipt`: duplicate deliveries of `X-Shopify-Webhook-Id` are safely acknowledged with `200 OK` without duplicate processing.
- Handled topics: `products/create`, `products/update`, `products/delete`, `app/uninstalled`.

### 4.5 Mandatory Compliance Webhooks
- `customers/data_request`: Acknowledged (CatalogFlow retains zero customer PII).
- `customers/redact`: Acknowledged (No customer PII stored in application database).
- `shop/redact`: Completely erases all retained shop data upon merchant app deletion.

---

## 5. Development & Testing Commands

```bash
# Run full automated test suite
npm test

# Run TypeScript typecheck
npm run typecheck

# Build client and server bundles
npm run build

# Start production server
npm start
```
