# IMPLEMENTATION PLAN: B2B Catalog / Buyer Order Portal for Shopify

> **Production Application Specification & Architecture**  
> **Source of Truth:** `B2B_Catalog_Buyer_Order_Portal_Production_Docs_TR.docx`  
> **Working Title:** CatalogFlow: B2B Order Catalog (Safe Catalog)  
> **Status:** Milestones M0, M1, M2, M3, M4, and M4.5 (Foundation Hardening) Completed  

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
|  - Mandatory Compliance Webhooks (customers/data_request, customers/redact, shop/redact)|
+-----------------------------------------------------------------------------------------+
                                 ▲                                   ▲
               Embedded App Auth | (GraphQL / HMAC)                  | GraphQL
                                 ▼                                   ▼
+----------------------------------------------------+   +--------------------------------+
|           MERCHANT EMBEDDED ADMIN                  |   |      PUBLIC BUYER PORTAL       |
|  - Shopify App Bridge + React + Polaris Components |   |  - Fast, responsive web UI     |
|  - Managed Installation & Token Exchange (RFC 8693)|   |  - URL: /c/:publicToken        |
|  - 3-Step Wizard: Sources -> Pricing -> Brand      |   |  - Search & Collection Filter  |
|  - Submissions History & Draft Order Deep Links    |   |  - Variant Quantity Matrix     |
|  - Quota & Billing Management                      |   |  - Sticky Order Summary & Cart |
+----------------------------------------------------+   +--------------------------------+
                          │                                              │
                          │                                              │ POST /submit
                          ▼                                              ▼ (Idempotency-Key)
+-----------------------------------------------------------------------------------------+
|                                APPLICATION BACKEND                                      |
|  - Node.js (TypeScript) + Express / React Router Server Engine                          |
|  - Centralized Services Layer:                                                          |
|      * auth.server.ts          -> Token Exchange (RFC 8693 urlencoded, id_token, expiring=1)|
|      * shopify-token.server.ts -> Centralized token rotation, atomic pair persistence   |
|      * crypto.server.ts        -> AES-256-GCM dual credential authenticated encryption  |
|      * shopify-client.server.ts-> Token-aware GraphQL client (auto 401 refresh & retry) |
|      * sync.server.ts          -> Complete collection & variant pagination, sync engine |
|      * pricing.server.ts       -> Deterministic Decimal arithmetic & currency formatting|
|      * catalog.server.ts       -> Catalog CRUD, source resolution, snapshot generator   |
|      * security.server.ts      -> Token validation, rate limiting, log sanitization     |
+-----------------------------------------------------------------------------------------+
                                              │
                                              ▼
+-----------------------------------------------------------------------------------------+
|                                  DATA PERSISTENCE                                       |
|  - PostgreSQL Database Engine (Production & Test with Prisma Migrations)                |
|  - Exact Decimal Money Types: shopifyPrice, subtotalAmount, discountPercent             |
|  - Relational Models: Shop (with expiring access + refresh credentials & timestamps),    |
|    Catalog, CatalogSource, CollectionSnapshot, CollectionProductMembership,              |
|    ProductSnapshot, VariantSnapshot, OrderSubmission                                    |
+-----------------------------------------------------------------------------------------+
```

---

## 3. Database Entities & Data Model (PostgreSQL)

- **`Shop`**: `id`, `shopDomain`, `accessToken` (Encrypted at rest with AES-256-GCM `enc:v1:...`), `accessTokenExpiresAt`, `refreshToken` (Encrypted at rest with AES-256-GCM), `refreshTokenExpiresAt`, `scopes`, `currency` (e.g. USD, EUR, GBP), `plan`, `billingCycleAnchor`, `monthlySubmissionsCount`, `installedAt`, `uninstalledAt`.
- **`Catalog`**: `id`, `shopId`, `name`, `publicToken` (256-bit unguessable hex), `status`, `priceMode`, `discountPercent` (Decimal 5, 2), `logoUrl`, `accentColor`, `showSku`, `showInventory`, `dataVersion`, `publishedAt`.
- **`CatalogSource`**: `id`, `catalogId`, `type` (`COLLECTION` | `PRODUCT`), `shopifyGid`.
- **`CollectionSnapshot`**: `id`, `shopId`, `shopifyCollectionId`, `title`, `handle`, `sourceUpdatedAt`, `syncedAt`.
- **`CollectionProductMembership`**: `id`, `collectionId`, `shopifyProductId`, `createdAt`.
- **`ProductSnapshot`**: `id`, `shopId`, `shopifyProductId`, `title`, `vendor`, `handle`, `imageUrl`, `status`, `sourceUpdatedAt`, `syncedAt`.
- **`VariantSnapshot`**: `id`, `shopId`, `shopifyVariantId`, `shopifyProductId`, `title`, `sku`, `barcode`, `shopifyPrice` (Decimal 12, 2), `inventoryQuantity`, `availableForSale`, `selectedOptionsJson`, `imageUrl`, `sourceUpdatedAt`, `syncedAt`.
- **`OrderSubmission`**: `id`, `shopId`, `catalogId`, `draftOrderId`, `draftOrderName`, `idempotencyKeyHash`, `itemCount`, `lineCount`, `subtotalAmount` (Decimal 12, 2), `currency`, `createdAt`. **Zero raw buyer PII persisted.**
- **`SyncRun`**: `id`, `shopId`, `type`, `status` (`PENDING` | `IN_PROGRESS` | `COMPLETED` | `FAILED`), `statsJson`, `startedAt`, `finishedAt`.
- **`WebhookReceipt`**: `id`, `webhookId` (Unique), `topic`, `shopDomain`, `status` (`PROCESSING`, `COMPLETED`, `FAILED`), `attempts`, `lastError`, `processedAt`, `completedAt`.

---

## 4. Milestone Execution Plan & Status

- [x] **M0: Spec & Repo Audit + Implementation Plan** *(Complete)*
- [x] **M1: Foundation, Git, PostgreSQL, Prisma & Shop Lifecycle** *(Complete)*
- [x] **M2: Merchant Catalog Domain & CRUD** *(Complete)*
- [x] **M3: Product Sync, Snapshots & Deterministic Pricing** *(Complete)*
- [x] **M4: Buyer Ordering Surface & UX** *(Complete)*
- [x] **M4.5: Foundation Correction & Shopify Integration Hardening** *(Complete)*
  - PostgreSQL migration created and deployed (`catalogflow` and `catalogflow_test`).
  - Shopify Managed Installation and Token Exchange (RFC 8693) implemented; legacy OAuth routes removed.
  - Token-at-rest encryption using authenticated AES-256-GCM.
  - Strict App Bridge session token validation (aud, iss, dest, exp).
  - Complete collection product pagination (>100 products multi-page).
  - Complete product variant pagination (>50 variants multi-page).
  - Selected options preservation (`Size=M` / `Color=Black`) through GraphQL sync into public buyer payload.
  - Collection webhook synchronization (`collections/create`, `collections/update`, `collections/delete`) and automatic membership reconciliation.
  - Webhook idempotency state machine (`PROCESSING` $\rightarrow$ `COMPLETED` / `FAILED`, retry support, concurrent lock protection).
  - Mandatory compliance webhooks (`customers/data_request`, `customers/redact`, `shop/redact`).
  - Decimal monetary calculations and currency formatting.
  - Public endpoint rate limiting and log sanitization.
- [x] **M4.5 Auth Patch: Expiring Offline Tokens, Refresh Rotation & Embedded Bootstrap** *(Complete)*
  - Upgraded Token Exchange to RFC 8693 `application/x-www-form-urlencoded` with `subject_token_type=urn:ietf:params:oauth:token-type:id_token` and `expiring=1`.
  - Non-destructive PostgreSQL migration (`20260907120642_expiring_offline_tokens`) for `accessTokenExpiresAt`, `refreshToken`, `refreshTokenExpiresAt`, `scopes`.
  - Encrypted both `accessToken` AND `refreshToken` at rest using AES-256-GCM.
  - Implemented centralized token rotation service (`shopify-token.server.ts`) with atomic token pair persistence, dynamic `expires_in` calculations, and in-flight deduplication.
  - Updated `ShopifyAdminClient` to be token-aware with automatic 401 refresh rotation and retry.
  - Implemented App Bridge invalid/stale ID token retry semantics (`HTTP 401` + `X-Shopify-Retry-Invalid-Session-Request: 1`) on both local validation failure and Shopify 400 rejection.
  - Implemented minimal embedded admin shell (`MerchantAppShell.tsx`) with App Bridge session bootstrap (`POST /api/admin/bootstrap`) while preserving public buyer portal (`/c/:publicToken`).
  - Added full test suite covering token exchange, token storage, token refresh rotation, App Bridge retry headers, and embedded bootstrap (65 total tests).
- [x] **M5: Submit-Time Revalidation, Draft Order Creation & Idempotency** *(Complete)*
  - Real-time catalog validation against PostgreSQL snapshots before Shopify mutation.
  - GraphQL `draftOrderCreate` mutation with exact decimal unit pricing, discount titles, buyer notes, and shipping address.
  - Returns draft order ID, draft order name, total items, and formatted subtotal.
- [x] **M5.5 & M5.6: Order Boundary Hardening, Failure Classification & Concurrency Safety** *(Complete)*
  - Rebuilt order idempotency as a formal state machine (`CREATING` $\rightarrow$ `COMPLETED` | `FAILED` | `REQUIRES_RECONCILIATION`).
  - Pre-Shopify database reservation prevents concurrent duplicate Draft Orders (`409 CONCURRENT_PROCESSING`).
  - Strict failure classification: conclusive GraphQL `userErrors` mark `FAILED` and release quota; ambiguous transport timeouts / 5xx mark `REQUIRES_RECONCILIATION` and preserve reserved quota.
  - Deterministic non-PII correlation reference (`cf-sub:<submissionId>`) on tags and custom attributes allows zero-duplicate Shopify-side GraphQL reconciliation.
  - FAILED retry quota re-reservation: retrying a `FAILED` submission atomically re-reserves a quota slot before transitioning to `CREATING`; prevents usage bypass.
  - Billing cycle rollover Compare-And-Set (CAS): atomic conditional SQL update prevents concurrent callers from overwriting active counts across 30-day boundary.
  - Clean manual sync engine: separated `executeFullShopSync` from `performInitialShopSync`; manual triggers generate exactly ONE `MANUAL` `SyncRun` with zero nested `INITIAL` runs.
  - Strict catalog authorization rejects out-of-catalog or cross-catalog variants (`422 INVALID_LINES`).
  - Submit-time `dataVersion` validation prevents orders on stale catalog pricing/structure (`409 CATALOG_CHANGED`).
  - Privacy hygiene: removed public token and idempotency key from Shopify tags/attributes; zero buyer PII persisted.
- [x] **M6: Submissions History & Merchant Operations** *(Complete)*
  - Submissions list endpoint (`GET /api/admin/submissions`) with pagination and summary metrics.
  - Direct deep links to native Shopify Admin Draft Orders.
  - Merchant catalog status transitions (`ACTIVE`, `DRAFT`, `ARCHIVED`) with automatic `dataVersion` bumps.
- [x] **M7: Merchant Operations & Submissions UX** *(Complete)*
  - Submissions list endpoint (`GET /api/admin/submissions`) with pagination, summary metrics, and status filtering (`ALL`, `COMPLETED`, `REQUIRES_RECONCILIATION`, `FAILED`).
  - Embedded merchant dashboard with Commercial Funnel card, KPI tracking, and deep links to native Shopify Admin Draft Orders.
  - Section 16 empty states, clear operational guidance, and merchant catalog lifecycle management.
- [x] **M8: Quotas, Billing Integration Boundary & Basic Analytics** *(Complete)*
  - Centralized single entitlement boundary via `BillingProvider` (`getEntitlement`, `getAvailablePlans`, `getPlanSelectionDestination`).
  - All quota enforcement (live catalogs, max variants, monthly submissions) strictly consumes verified entitlements through `BillingProvider`.
  - Production invariant: `Shop.plan` is an entitlement mirror/cache, not a merchant-controlled source of truth.
  - Production self-service plan changes blocked with `403 BILLING_NOT_CONFIGURED`; dev/test override strictly isolated.
  - Shopify App Pricing live integration: **PENDING M10** (source explicitly marked `LOCAL_MIRROR_PENDING_SHOPIFY` until M10 Partner Dashboard setup).
  - Commercial Plan Tiers: Starter ($14.99, 1 catalog, 500 variants, 50 orders/mo), Growth ($29.99, 5 catalogs, 5,000 variants, 250 orders/mo), Scale ($49.99, 20 catalogs, 25,000 variants, 1,000 orders/mo). 7-day trial in Shopify App Pricing; zero overage, no permanent free tier.
  - Strict analytics metadata privacy allowlist (`ORDER_SUMMARY_STARTED`: `itemCount`, `lineCount`; Server order events: `submissionId`, `itemCount`, `lineCount`, `subtotal`, `currency`). All PII and unknown keys discarded.
  - Accurate North Star event (`draft_order_created_from_buyer_submission`) recorded idempotently once across normal completion and reconciliation via deterministic `eventKey`.
  - Non-blocking buyer catalog analytics (`void recordAnalyticsEvent(...)`) and bounded query validation (`1 <= days <= 90`).
- [x] **M9: Security / Reliability / Edge Cases / Performance / Visual Polish** *(Complete)*
  - Non-reversible hashed IP sliding window rate limiting (`sha256(ip + ':' + routeCategory + ':' + publicToken)`).
  - Strict input limits and DoS protection (500 lines cap, 100,000 qty cap, string length limits).
  - Webhook fast-ack (<500ms) with persistent PostgreSQL `BackgroundJob` queue (`FOR UPDATE SKIP LOCKED`).
  - Standalone worker daemon (`src/worker.ts`) with poison-job circuit breaker and uninstalled shop dropping.
  - Merchant submission reconciliation endpoint & UI action ("Check Shopify ↻") with zero duplicate order risk.
  - N+1 query elimination in collection membership lookups.
  - Shopify GraphQL client throttling detection with exponential backoff and jitter.
  - Human buyer error states (unpublished, inactive store, empty catalog, stale data version refresh).
  - Accessible variant matrix table with keyboard navigation.
  - Health (`/health`) and readiness (`/ready`) observability probes.
  - Fail-fast environment configuration validation.
  - Complete test suite across 10 test files with 143 passing tests.
  - Operations runbook documentation (`OPERATIONS.md`).
- [ ] **M10: Shopify Integration, Real E2E, App Store Readiness & Submission** *(NEXT MILESTONE)*
  - Partner Dashboard app credentials & Shopify App Pricing live setup.
  - End-to-end production validation & Shopify App Store review pre-submission checklist.
