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
- **Test Suite:** Vitest (101 automated unit, integration, and security test cases across 8 test suites)

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

### 4.6 Production Draft Order Pipeline & Order Boundary Hardening (M5 / M5.5 / M5.6)
- **Order Idempotency State Machine (`OrderSubmission`):**
  - States: `CREATING` $\rightarrow$ `COMPLETED` | `FAILED` | `REQUIRES_RECONCILIATION`.
  - Pre-Shopify database reservation prevents race conditions; concurrent attempts encounter `409 CONCURRENT_PROCESSING`.
  - Completed submissions return `200 OK` with existing submission data and `idempotentReplay: true`.
- **Mutation Failure Classification & Reconciliation:**
  - **Conclusive Shopify Rejection (GraphQL `userErrors`):** Marks submission `FAILED`, atomically releases reserved quota, and allows safe retry.
  - **Ambiguous Transport Failure (Timeout, ECONNRESET, HTTP 5xx):** Marks submission `REQUIRES_RECONCILIATION`, keeps quota reserved, preserves `correlationRef`, and requires tag-based reconciliation on retry before any new mutation.
  - Every order attaches a deterministic, non-PII correlation identifier: `cf-sub:<submissionId>` to Draft Order tags and `_cf_submission_ref` custom attribute.
  - On retry of an ambiguous attempt, the engine queries Shopify Admin GraphQL (`draftOrders(first: 1, query: "tag:cf-sub:<submissionId>")`) to safely recover the created Draft Order without executing a second mutation.
- **FAILED Retry Quota Reservation Lifecycle:**
  - A previously `FAILED` submission released its quota slot on failure.
  - On retry, it must reconcile the billing cycle and atomically reserve a quota slot again before transitioning back to `CREATING`.
  - If the store has reached its limit in the interim, retry is rejected with `403 QUOTA_EXCEEDED` without calling Shopify.
- **Compare-And-Set (CAS) Billing Cycle Rollover:**
  - `reconcileBillingCycle` uses an atomic SQL CAS update (`WHERE "id" = $1 AND "billingCycleAnchor" <= $cutoff`) to advance the 30-day billing anchor and reset `monthlySubmissionsCount = 0`.
  - Prevents concurrent callers from clobbering or wiping out active reservations across the cycle boundary.
- **Strict Catalog Authorization & Variant Boundary:**
  - Validates that every submitted line item variant GID belongs to a product actively mapped to the catalog.
  - Out-of-catalog or cross-catalog variants are rejected with `422 INVALID_LINES`.
- **Submit-Time `dataVersion` Stale-Data Guard:**
  - If the merchant has modified pricing or collections (`dataVersion` mismatch), submission is rejected with `409 CATALOG_CHANGED` before touching Shopify.
- **Clean Single-Run Manual Sync:**
  - `triggerManualShopSync` invokes `executeFullShopSync` directly under a single `MANUAL` `SyncRun`.
  - Zero nested `INITIAL` runs are created, and `initialSyncAt` is preserved for true install lifecycles. Overlapping sync requests return `409 SYNC_IN_PROGRESS`.
- **Privacy & Metadata Hygiene:**
  - Public tokens and raw idempotency keys are strictly excluded from Draft Order tags and custom attributes. Zero raw buyer PII is retained in the database.

### 4.7 Merchant Operations & Submissions History (M6 / M7)
- **Embedded Submissions Table:** Lists all buyer order submissions with timestamp, catalog title, line count, item count, formatted subtotal currency, and status.
- **Submissions Status Filtering:** Filter by `ALL`, `COMPLETED`, `REQUIRES_RECONCILIATION`, and `FAILED`.
- **Commercial Funnel Analytics:** Tracks catalog views $\rightarrow$ order summaries $\rightarrow$ orders submitted $\rightarrow$ Shopify Draft Orders created.
- **Deep Links to Shopify Admin:** Direct deep links to native Shopify Draft Orders (`https://{shop}/admin/draft_orders/{id}`).
- **Catalog Status Management:** Instant publish, unpublish, and archive operations with immediate `dataVersion` increments.

### 4.8 Commercial Pricing, Quotas & Analytics Boundary (M8)
- **Centralized Entitlement Boundary (`BillingProvider`):** All commercial limits resolve through a single entitlement service. In production, `Shop.plan` is an entitlement mirror/cache, not a merchant-controlled source of truth.
- **Production Change-Plan Protection:** `POST /api/admin/billing/change-plan` returns `403 BILLING_NOT_CONFIGURED` in production. Dev/test overrides are strictly isolated (`NODE_ENV === 'test'`).
- **Shopify App Pricing Status:** Live integration pending M10 Partner Dashboard setup (`LOCAL_MIRROR_PENDING_SHOPIFY`).
- **Normalized Plan Tiers:**
  - **Starter ($14.99/mo):** 1 live catalog, 500 variants / catalog, 50 orders / month, 7-day trial.
  - **Growth ($29.99/mo):** 5 live catalogs, 5,000 variants / catalog, 250 orders / month, 7-day trial.
  - **Scale ($49.99/mo):** 20 live catalogs, 25,000 variants / catalog, 1,000 orders / month, 7-day trial.
  - *Hard caps only; no overage billing; no permanent free tier.*
- **Strict Analytics Privacy:** Metadata allowlist strictly discards all PII, buyer notes, company names, and arbitrary nested JSON.
- **Accurate & Idempotent North Star:** `draft_order_created_from_buyer_submission` is recorded exactly once across normal and reconciled orders using a deterministic `eventKey`.
- **Non-Blocking Buyer Analytics:** Catalog view analytics are fire-and-forget, ensuring zero latency impact on buyer portal loads.

### 4.9 Production Hardening, Worker & Reliability (M9)
- **Fast-Ack Webhook Queue:** Shopify webhooks acknowledge (<500ms) with 200 OK after inserting into a persistent PostgreSQL `BackgroundJob` table.
- **Standalone Background Worker Daemon (`src/worker.ts`):** Polls jobs concurrency-safely via `FOR UPDATE SKIP LOCKED`, handles retries with exponential backoff, and safely drops jobs for uninstalled stores.
- **Merchant Submission Reconciliation:** Single-click "Check Shopify ↻" button safely checks for `tag:cf-sub:<id>` without ever calling `draftOrderCreate` or risking duplicate orders.
- **Privacy-Preserving Rate Limiting:** Non-reversible hashed bucket keys (`sha256(ip + ':' + routeCategory + ':' + publicToken)`) with standard `Retry-After` headers.
- **Input Bounds & DoS Protection:** 500 line items cap per order, 100,000 maximum quantity per line, and bounded string inputs.
- **Observability Probes:** `/health` (liveness with uptime) and `/ready` (database connectivity probe).
- **Environment Fail-Fast Validation:** Validates required configuration keys and minimum secret lengths before server/worker boot.

---

## 5. Development & Testing Commands

```bash
# Run full automated test suite (10 test suites, 143+ tests)
npm test

# Run TypeScript typecheck
npm run typecheck

# Build client and server bundles
npm run build

# Start background worker daemon
npm run worker

# Start web server
npm start
```
