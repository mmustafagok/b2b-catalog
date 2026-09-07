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

## 3. Test Suites & Coverage Summary (41 Tests)

### 3.1 Milestone 1: Shop Lifecycle, Auth & Encryption (`tests/m1_lifecycle_and_auth.test.ts` — 11 Tests)
- Initial shop installation with encrypted access token and default Starter plan.
- Shop uninstallation setting `uninstalledAt` and revoking token.
- Shop re-installation reactivating previously uninstalled shops.
- Shop quota calculation for catalog limits and monthly order submissions.
- AES-256-GCM authenticated encryption roundtrip with fresh random IVs.
- AES-256-GCM failure on wrong decryption key or tampered envelope.
- Shopify webhook HMAC SHA-256 validation (accepts valid, rejects tampered/empty).
- Strict myshopify domain format validation.
- App Bridge JWT session token verification (exp, nbf, aud, iss, dest host match).

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

### 3.5 Milestone 4.5: Collections, Initial Sync & Webhooks (`tests/m4_5_collections_and_sync.test.ts` — 12 Tests)
- **Exact Collection Resolution:** Sourcing Collection A resolves only products in Collection A, never products from Collection B.
- **Mixed Sourcing:** Collection A + explicit Product C resolves without duplicates.
- **Dynamic Membership:** Removing a product from a collection removes it from resolved catalogs.
- **Initial Sync:** Paginated Shopify Admin GraphQL sync for collections, products, variants, and currency.
- **Sync Failure Audit:** Records `SyncRun` status = `FAILED` on Shopify API errors.
- **Webhook Fail-Closed:** Webhooks without valid HMAC or secret return `401`.
- **Webhook Idempotency:** Duplicate `X-Shopify-Webhook-Id` is recognized and safely acknowledged.
- **Compliance Webhooks:**
  - `customers/data_request` returns 200 acknowledgment.
  - `customers/redact` returns 200 acknowledgment.
  - `shop/redact` erases shop and cascades deletion of retained data.
- **Currency & Money:** Formatting across non-USD currencies (EUR, GBP, CAD) and decimal precision.
