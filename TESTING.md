# Testing Strategy & Verification Guide

This document details the automated test suites, execution procedures, and quality gates for CatalogFlow.

---

## 1. Test Environment & Database Setup

The test suite runs against a dedicated PostgreSQL test database (`catalogflow_test`) to verify real database constraints, foreign keys, and Decimal arithmetic.

```bash
# Ensure PostgreSQL is running on localhost:5432
# Create test database if not already created
psql -U postgres -h localhost -p 5432 -c "CREATE DATABASE catalogflow_test;"

# Apply Prisma migrations
$env:DATABASE_URL="postgresql://postgres:postgres@localhost:5432/catalogflow_test?schema=public"
npm run prisma:deploy
```

---

## 2. Test Execution Commands

```bash
# Run all automated tests
npm test

# Run tests in watch mode during development
npm run test:watch

# Run TypeScript typecheck
npm run typecheck
```

---

## 3. Test Suites & Coverage Summary (101 Tests across 8 Suites)

### 3.1 Milestone 1 & 4.5 Auth: Shop Lifecycle, Auth, Encryption & Token Rotation (`tests/m1_lifecycle_and_auth.test.ts` — 26 Tests)
- **Lifecycle & Plans:**
  - Initial shop installation with encrypted access token and default Starter plan.
  - Shop uninstallation setting `uninstalledAt` and revoking token.
  - Shop re-installation reactivating previously uninstalled shops.
  - Shop quota calculation for catalog limits and monthly order submissions.
- **Crypto & Webhooks:**
  - AES-256-GCM authenticated encryption roundtrip with fresh random IVs.
  - AES-256-GCM failure on wrong decryption key or tampered envelope (`CryptoError`).
  - Shopify webhook HMAC SHA-256 validation (accepts valid, rejects tampered/empty).
  - Strict myshopify domain format validation.
  - App Bridge JWT session token verification (exp, nbf, aud, iss, dest host match).
- **Shopify Managed Installation & Expiring Token Exchange (RFC 8693):**
  - Exchange session token for expiring offline access token via `application/x-www-form-urlencoded`.
  - Enforces `urn:ietf:params:oauth:token-type:id_token` subject token type and `expiring=1`.
  - Parsed token response metadata (`expiresIn`, `scope`, `refreshToken`, `refreshTokenExpiresIn`).
  - Stores encrypted access token, encrypted refresh token, and expiry timestamps in PostgreSQL.
  - Token exchange endpoint (`POST /api/auth/token-exchange`) persists credentials and triggers initial sync.
  - Reinstallation safely refreshes and reactivates credentials.
  - Legacy OAuth routes (`/auth/shopify`, `/auth/callback`) return 404.
- **Server-Side Token Refresh Rotation (`shopify-token.server.ts`):**
  - Does NOT refresh a valid access token far from expiry.
  - Automatically refreshes near-expiry token (<5 min) using stored refresh token.
  - Atomically persists rotated token pair and updated expiry timestamps in DB.
  - Subsequent requests immediately use newly rotated token without re-fetching.
  - Failed refresh with network/server 500 does NOT overwrite or wipe valid stored credentials.
  - Rejection with 400/401 produces typed `ShopifyAuthRequiredError` (re-auth required).
  - GraphQL client (`ShopifyAdminClient`) automatically handles 401, forces refresh, and retries once.
- **App Bridge Stale Token Retry Semantics:**
  - Invalid or expired ID token returns HTTP 401 with `X-Shopify-Retry-Invalid-Session-Request: 1`.
  - Upstream Shopify token endpoint HTTP 400 (stale session token) translates to HTTP 401 with retry header.
- **Embedded Admin Bootstrap & Public Portal Isolation:**
  - Embedded admin bootstrap (`POST /api/admin/bootstrap`) authenticates, establishes credentials, and triggers sync.
  - Uninstalled shops are reactivated upon embedded bootstrap.
  - Public buyer portal (`/c/:publicToken` and `/api/public/catalog/:publicToken`) remains public, fast, and completely isolated without admin retry headers.

### 3.2 Milestone 2: Merchant Catalog Domain & CRUD (`tests/m2_catalog_domain.test.ts` — 5 Tests)
- Catalog creation in `DRAFT` status with sources, 256-bit token, and data versioning.
- Strict multi-tenant isolation: Shop B cannot view, update, publish, or delete Shop A's catalog.
- Updating catalog details and changing sources increments `dataVersion`.
- Plan quota enforcement on publishing (Starter plan limited to 1 live catalog).
- Public visibility rules: unpublished catalogs or uninstalled shop catalogs return `null` (404).

### 3.3 Milestone 3: Product Sync, Snapshot Cache & Pricing (`tests/m3_sync_and_pricing.test.ts` — 7 Tests)
- Deterministic Prisma Decimal half-up rounding.
- Wholesale display price calculation across discount ranges (0%, 10%, 25%, 33.3%, 90%).
- Normalization of numeric IDs to Shopify GraphQL GIDs.
- Product and variant snapshot ingestion with option mappings.
- Pruning of deleted variants upon incoming product updates.
- Cascade deletion of variants on `deleteProductSnapshot`.
- Public catalog payload generation with pre-computed wholesale prices.

### 3.4 Milestone 4: Public Buyer Ordering API (`tests/m4_buyer_ux_and_api.test.ts` — 6 Tests)
- Server health check endpoint (`/health`).
- Public catalog retrieval endpoint (`GET /api/public/catalog/:publicToken`).
- Rejection of malformed tokens (400) and unknown tokens (404).
- Pre-submit validation of valid buyer order lines (`POST /api/public/catalog/:publicToken/validate`).
- Out-of-stock detection during pre-submit validation.
- Merchant Admin API authentication middleware and tenant scoping.

### 3.5 Milestone 4.5: Collections, Initial Sync & Webhooks (`tests/m4_5_collections_and_sync.test.ts` — 21 Tests)
- **Exact Collection Resolution:** Sourcing Collection A resolves only products in Collection A, never products from Collection B.
- **Mixed Sourcing:** Collection A + explicit Product C resolves without duplicates.
- **Dynamic Membership:** Removing a product from a collection removes it from resolved catalogs.
- **Collection Pagination:** Fully paginates collection product memberships (>100 products across multiple pages) without dropping products.
- **Variant Pagination:** Fully paginates product variants (>50 variants across multiple pages) without premature pruning.
- **Selected Options Preservation:** Preserves GraphQL `selectedOptions` (`Size=M` / `Color=Black`) through snapshot sync into public buyer payload.
- **Initial Sync:** Paginated Shopify Admin GraphQL sync for collections, products, variants, and currency.
- **Sync Failure Audit:** Records `SyncRun` status = `FAILED` on Shopify API errors.
- **Webhook Fail-Closed:** Webhooks without valid HMAC or secret return `401`.
- **Webhook Idempotency State Machine:**
  - `FAILED` delivery records failure status and allows Shopify retry.
  - Retried webhook succeeds and transitions to `COMPLETED`.
  - Duplicate delivery of `COMPLETED` webhook safely acknowledges with 200 without re-executing.
  - Concurrent delivery while `PROCESSING` returns 429 lock protection.
- **Collection Webhook Synchronization:**
  - `collections/update` adds product to collection and updates public catalog payload.
  - `collections/update` removes product from collection and updates public catalog payload.
  - `collections/delete` deletes collection snapshot and increments catalog `dataVersion`.
  - `products/update` reconciles catalog-sourced collections.
- **Compliance Webhooks:**
  - `customers/data_request` returns 200 acknowledgment.
  - `customers/redact` returns 200 acknowledgment.
  - `shop/redact` erases shop and cascades deletion of retained data.
- **Currency & Money:** Formatting across non-USD currencies (EUR, GBP, CAD) and decimal precision.

### 3.6 Milestone 5: Submit-Time Live Revalidation, Draft Order Creation & Idempotency (`tests/m5_draft_order_and_idempotency.test.ts` — 8 Tests)
- Mandatory `Idempotency-Key` header enforcement (missing or whitespace returns 400).
- Live variant revalidation (`getVariantsByIds`) before mutation.
- Stale price detection returning `HTTP 409 Conflict` (`CATALOG_CHANGED`).
- Out-of-stock and deleted item detection returning `HTTP 409 Conflict`.
- Percentage discount calculation and line item discount formatting.
- Draft Order creation via `draftOrderCreate` mutation with business notes and PO number.
- Basic idempotency duplicate returns existing submission without second Shopify call.
- Zero raw buyer PII stored in local database model.

### 3.7 Milestone 6: Submissions History & Merchant Operations (`tests/m6_submissions_and_operations.test.ts` — 5 Tests)
- Paginated submissions retrieval (`GET /api/admin/submissions`) scoped to authenticated shop.
- Shopify Admin Draft Order deep link generation (`https://${shopDomain}/admin/draft_orders/${numericId}`).
- Strict multi-tenant isolation: Shop B cannot view Shop A submissions.
- Filter submissions by `catalogId`.
- Comprehensive sync health summary (`GET /api/admin/sync/health`).

### 3.8 Milestone 5.5, 5.6 & 5.7: Order Boundary Hardening, Idempotency Lease & Quota Period Safety (`tests/m5_5_order_boundary_hardening.test.ts` — 22 Tests)
- **Concurrency & Idempotency State Machine:**
  - Two concurrent same-key submissions (`Promise.all`) execute exactly one Shopify mutation; second receives in-progress/existing result.
  - Shopify mutation succeeds + DB update throws -> retry reconciles via correlation tag (`cf-sub:<id>`) with zero duplicate Draft Orders.
  - Different idempotency keys intentionally create separate Draft Orders.
- **Ambiguous Failure Classification & Reconciliation (M5.6 & M5.7):**
  - E2E submit flow: timeout / network failure right after draftOrderCreate side effect sets local state to `REQUIRES_RECONCILIATION`.
  - Reserved quota slot is preserved (not prematurely released on ambiguous transport failure).
  - **No Fallthrough Invariant (M5.7):** Empty search response on reconciliation retry *never* falls through to `draftOrderCreate`. Returns `HTTP 409 RECONCILIATION_PENDING` while keeping quota slot reserved. Subsequent retry that finds original draft transitions to `COMPLETED` without incrementing mutation call count (remains 1).
- **Processing Lease Age Correctness (`processingStartedAt`) (M5.7):**
  - Uses explicit `processingStartedAt DateTime?` lease timestamp instead of `createdAt`.
  - Initial reservation and `FAILED -> CREATING` retry both initialize `processingStartedAt = now`.
  - Submissions created hours ago that retry receive fresh 60s lease window; concurrent retries are rejected with `409 CONCURRENT_PROCESSING`.
  - Stale lease with `processingStartedAt > 60s` triggers deterministic reconciliation.
  - Terminal transitions (`COMPLETED`, `FAILED`, `REQUIRES_RECONCILIATION`) clear lease (`processingStartedAt: null`).
- **Period-Aware Quota Reservation & Release (M5.7):**
  - `OrderSubmission` captures and records `quotaCycleAnchor DateTime?` and `quotaReserved Boolean @default(false)`.
  - On release, `monthlySubmissionsCount` is *only* decremented if `Shop.billingCycleAnchor === submission.quotaCycleAnchor` AND `submission.quotaReserved === true`.
  - Atomic release prevents old billing-cycle failure from decrementing new billing-cycle usage.
  - Duplicate releases cannot decrement quota twice.
- **FAILED Retry Quota Lifecycle (M5.6):**
  - Conclusive rejection (GraphQL `userErrors`) releases reserved quota and marks `FAILED`.
  - Same-key retry of a `FAILED` submission atomically re-reserves a quota slot before transitioning back to `CREATING`.
  - If store quota reaches limit between attempts, retry is rejected with `403 QUOTA_EXCEEDED` without calling Shopify.
- **Billing Cycle Rollover Compare-And-Set (CAS) (M5.6):**
  - Multiple concurrent reservation requests across expired 30-day boundary execute atomic CAS rollover.
  - Exactly one cycle reset occurs; subsequent concurrent reservations increment active counter accurately without race loss.
- **Catalog Authorization:**
  - Same-shop but out-of-catalog variant rejected with `HTTP 422 INVALID_LINES` before calling Shopify.
  - Mixed valid/invalid cart rejected entirely without partial draft orders.
  - Wholesale discount never applied to unauthorized lines.
- **Catalog Version (`dataVersion`):**
  - Stale `dataVersion` returns `HTTP 409 CATALOG_CHANGED` before calling Shopify.
  - Current `dataVersion` succeeds.
- **Quota Lifecycle & Concurrency Hard Cap:**
  - 30-day billing period rollover automatically resets usage and advances anchor.
  - 49/50 quota with two concurrent distinct submissions (`Promise.all`) -> exactly one succeeds, one receives `403 QUOTA_EXCEEDED`.
  - Failed-before-side-effect attempt releases reserved quota slot.
- **Manual Sync Single-Run Architecture (M5.6):**
  - Manual sync trigger creates exactly ONE `SyncRun` of type `MANUAL`.
  - Zero nested `INITIAL` runs created; `initialSyncAt` timestamp remains untouched by manual sync.
  - Overlapping click while sync is `IN_PROGRESS` returns `HTTP 409 SYNC_IN_PROGRESS`.
- **Privacy & Metadata:**
  - Draft Order custom attributes strictly exclude `CatalogFlow Public Token` and raw idempotency key.
  - Local database stores no raw buyer email or notes.
