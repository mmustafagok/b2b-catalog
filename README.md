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
- **Test Suite:** Vitest (96 automated unit, integration, and security test cases across 8 test suites)

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

### 4.1 Shopify Managed Installation, Expiring Offline Tokens & Refresh Rotation
1. **Managed Installation Surface:** Installation consent and scope authorization (`read_products,read_inventory,write_draft_orders,read_draft_orders`) are natively owned and presented by Shopify without legacy authorization-code OAuth redirects or manual install forms.
2. **Token Exchange (RFC 8693) & Expiring Offline Token Contract:**
   - Embedded merchant admin loads with an App Bridge session token (ID token).
   - Backend performs token exchange against `POST https://{shop}.myshopify.com/admin/oauth/access_token` using `application/x-www-form-urlencoded`.
   - Contract parameters:
     - `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`
     - `subject_token=<session_token>`
     - `subject_token_type=urn:ietf:params:oauth:token-type:id_token`
     - `requested_token_type=urn:shopify:params:oauth:token-type:offline-access-token`
     - `expiring=1`
   - Response provides: `access_token`, `expires_in`, `scope`, `refresh_token`, and `refresh_token_expires_in`.
3. **Double Credential Encryption at Rest (AES-256-GCM):**
   - Both `accessToken` and `refreshToken` are sensitive credentials encrypted at rest with versioned authentication tags (`crypto.server.ts`).
   - `Shop` database model tracks `accessToken`, `accessTokenExpiresAt`, `refreshToken`, `refreshTokenExpiresAt`, and `scopes`.
   - Neither token is ever exposed to the client browser or written to application logs.
4. **Centralized Credential Service & Refresh Token Rotation (`shopify-token.server.ts`):**
   - `getValidOfflineAccessToken(shopId, options)` inspects token lifetime using a 5-minute safety buffer.
   - Automatically executes refresh token rotation via `grant_type=refresh_token` when nearing expiry or on demand.
   - Uses returned `expires_in` dynamically (no hardcoded lifetime).
   - Atomically updates and persists the newly rotated access and refresh token pair and expiry timestamps.
   - Prevents concurrent refresh storms via in-process in-flight refresh deduplication.
   - Throws typed `ShopifyAuthRequiredError` if refresh credentials are revoked, prompting embedded re-authentication.
5. **Token-Aware GraphQL Client (`shopify-client.server.ts`):**
   - Resolves valid offline access tokens dynamically via `shopify-token.server.ts`.
   - Automatically traps HTTP 401 unauthorized responses from Shopify, forces refresh rotation, and retries the request before failing.
6. **App Bridge Invalid/Stale ID Token Retry Protocol:**
   - On missing, untrusted, or expired ID tokens, the server responds with:
     `HTTP 401`
     `X-Shopify-Retry-Invalid-Session-Request: 1`
   - If Shopify token exchange returns HTTP 400 for a stale ID token, the backend translates this upstream error into HTTP 401 with `X-Shopify-Retry-Invalid-Session-Request: 1`.
   - This allows App Bridge to silently obtain a fresh session token and retry once without failing the merchant session.
7. **Minimal Embedded Admin Shell & Bootstrap (`/` & `/api/admin/bootstrap`):**
   - Embedded merchant admin loads App Bridge via CDN.
   - Makes an authenticated bootstrap call to `POST /api/admin/bootstrap`.
   - Verifies credentials, reactivates uninstalled shops, and kicks off initial sync in the background for new stores.
   - Public buyer portal (`/c/:publicToken`) remains public, fast, and completely isolated from admin authentication.

### 4.2 Complete Collection & Variant Pagination
- **Collection Membership Pagination:** Recursively pages through `collection.products(first: 100, after: $cursor)` until `hasNextPage: false`. Never truncates collection memberships; stale memberships are only replaced after the full membership set has resolved.
- **Product Variant Pagination:** Recursively pages through `product.variants(first: 100, after: $cursor)` until `hasNextPage: false`. Supports Shopify's high-variant products; variants are never pruned prematurely.
- **Selected Options Preservation:** GraphQL `selectedOptions` (`[{ name: 'Size', value: 'M' }, { name: 'Color', value: 'Black' }]`) are strictly preserved in `VariantSnapshot.selectedOptionsJson` and exposed in the public buyer payload.

### 4.3 Webhook Idempotency State Machine
- `WebhookReceipt` state machine tracks `PROCESSING` -> `COMPLETED` | `FAILED`:
  - `PROCESSING`: Marks initial receipt; concurrent duplicates within lock window are rejected with `429` to avoid race conditions without losing events.
  - `FAILED`: On processing exceptions, the endpoint returns non-2xx; Shopify retries re-enter `PROCESSING` and can succeed on retry.
  - `COMPLETED`: Only successfully applied mutations are marked `COMPLETED`. Duplicate deliveries are acknowledged with `200 OK` without re-executing mutations.
  - Last failure messages are sanitized (PII-free).

### 4.4 Collection & Product Webhook Synchronization
- Subscribes to: `collections/create`, `collections/update`, `collections/delete`, `products/create`, `products/update`, `products/delete`, `app/uninstalled`.
- `collections/update` / `create`: Fetches collection details and fully paginates product memberships, updating `CollectionSnapshot` and incrementing catalog `dataVersion`.
- `collections/delete`: Removes snapshot and cascaded memberships, incrementing `dataVersion`.
- `products/update`: Triggers targeted membership reconciliation for catalog-sourced collections so smart collections stay fresh.

### 4.5 Mandatory Compliance Webhooks
- `customers/data_request`: Acknowledged (CatalogFlow retains zero customer PII).
- `customers/redact`: Acknowledged (No customer PII stored in application database).
- `shop/redact`: Completely erases all retained shop data upon merchant app deletion.

### 4.6 Production Draft Order Pipeline & Order Boundary Hardening (M5 / M5.5)
- **Order Idempotency State Machine (`OrderSubmission`):**
  - States: `CREATING` $\rightarrow$ `COMPLETED` | `FAILED` | `REQUIRES_RECONCILIATION`.
  - To eliminate race conditions where two concurrent requests create multiple Shopify Draft Orders before DB insertion, the row is pre-reserved in PostgreSQL with `status: 'CREATING'` and a unique `idempotencyKeyHash`. Concurrent attempts encounter `409 CONCURRENT_PROCESSING`.
  - Completed submissions return `200 OK` with existing submission data and `idempotentReplay: true`.
- **Shopify Reconciliation via Deterministic Correlation Reference:**
  - Every order attaches a deterministic, non-PII correlation identifier: `cf-sub:<submissionId>` (e.g. `cf-sub:cly...`) to Draft Order tags and `_cf_submission_ref` custom attribute.
  - If Shopify Draft Order creation succeeds or is ambiguous due to a database/network crash, the submission enters `REQUIRES_RECONCILIATION`.
  - On retry, the engine queries Shopify Admin GraphQL (`draftOrders(first: 1, query: "tag:cf-sub:<submissionId>")`) to safely recover the created Draft Order without executing a second mutation.
- **Strict Catalog Authorization & Variant Boundary:**
  - Validates that every submitted line item variant GID belongs to a product actively mapped to the catalog (via product sources or collection membership snapshots).
  - Out-of-catalog or cross-catalog variants are rejected with `422 INVALID_LINES`.
- **Submit-Time `dataVersion` Stale-Data Guard:**
  - Buyer requests include the client's observed `dataVersion`.
  - If the merchant has modified pricing, published revisions, or updated collections (`dataVersion` mismatch), submission is rejected with `409 CATALOG_CHANGED` before touching Shopify.
- **Rolling 30-Day Billing Cycle Quota Lifecycle:**
  - `reconcileBillingCycle` automatically checks if `now >= billingCycleAnchor + 30 days` and rolls the anchor forward while resetting `monthlySubmissionsCount = 0`.
- **Concurrency-Safe Atomic Quota Hard Cap:**
  - `reserveSubmissionQuotaSlot` executes an atomic conditional SQL update (`UPDATE "Shop" SET "monthlySubmissionsCount" = "monthlySubmissionsCount" + 1 WHERE id = $1 AND "monthlySubmissionsCount" < $limit`).
  - Concurrent requests near the limit (e.g. 49/50 on Free Tier) cannot race to exceed the cap. On downstream failure, `releaseSubmissionQuotaSlot` atomically rolls back the increment.
- **Privacy & Metadata Hygiene:**
  - Public tokens and raw idempotency keys are strictly excluded from Draft Order tags and custom attributes.
  - Only clean identifiers (`CatalogFlow Order`, `cf-sub:<submissionId>`, `_cf_submission_ref`, `PO Number`) are sent to Shopify. Zero raw buyer PII is retained in the database.
- **Manual Sync Deduplication:**
  - `POST /api/admin/sync/trigger` validates in-progress runs; concurrent or overlapping sync requests return `409 SYNC_IN_PROGRESS`.

### 4.7 Merchant Operations & Submissions History (M6)
- **Embedded Submissions Table:** Lists all buyer order submissions with timestamp, catalog title, line count, item count, formatted subtotal currency, and status.
- **Deep Links to Shopify Admin:** Direct deep links to native Shopify Draft Orders (`https://{shop}/admin/draft_orders/{id}`).
- **Catalog Status Management:** Instant publish, unpublish, and archive operations with immediate `dataVersion` increments.

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
