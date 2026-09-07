# Security & Compliance Model: CatalogFlow

This document outlines the multi-layered security and compliance architecture implemented in CatalogFlow.

---

## 1. Dual Credential Protection at Rest & Expiring Token Model

- **Expiring Offline Tokens:** CatalogFlow uses Shopify's modern expiring offline access token model (`expiring=1`). Access tokens are short-lived, minimizing the blast radius of any credential disclosure.
- **Dual Credential Encryption (AES-256-GCM):**
  - Both `accessToken` AND `refreshToken` are treated as high-sensitivity credentials and encrypted at rest with AES-256-GCM.
  - Unique cryptographically random 12-byte (96-bit) IV generated per encryption event.
  - 16-byte (128-bit) GCM authentication tag verifies payload integrity and authenticity.
  - Envelope format: `enc:v1:<iv_hex>:<authTag_hex>:<ciphertext_hex>`.
  - Keys derived deterministically from `ENCRYPTION_SECRET` via SHA-256 (32 bytes).
- **Server-Side Token Refresh Rotation:**
  - Token refresh occurs exclusively server-side in `shopify-token.server.ts`.
  - When an access token is expiring or expired, the stored encrypted refresh token is used to obtain a new access and refresh token pair via `grant_type=refresh_token`.
  - The new token pair and updated expiry timestamps are persisted atomically.
  - In-process deduplication avoids concurrent refresh storms.
  - Revoked refresh tokens raise `ShopifyAuthRequiredError`, requiring fresh merchant session authentication.
- **Zero Client Exposure:** Neither access tokens nor refresh tokens are ever sent to client browsers or printed in log output.
- **App Bridge Stale Token Retry Protocol:**
  - When an App Bridge session token is invalid, expired, or rejected with HTTP 400 by Shopify, the server returns `HTTP 401` with `X-Shopify-Retry-Invalid-Session-Request: 1`, allowing App Bridge to automatically refresh the session token and retry.
- **Safe Failure:** Tampered payloads or incorrect decryption keys throw a strict `CryptoError` preventing unauthorized token use.

---

## 2. Multi-Tenant Data Isolation

- Every database query in the Merchant Admin API enforces ownership scoping: `where: { shopId: authenticatedShop.id }`.
- Cross-shop reads, updates, publishing, or deletion attempts are rejected with `404 Not Found` or `CatalogError`.
- Tenant boundaries are verified in automated test suites (`tests/m2_catalog_domain.test.ts`).

---

## 3. Session Token Verification (App Bridge JWT)

Embedded Admin requests require a Bearer token issued by Shopify App Bridge. The verification algorithm validates:
1. **Signature Integrity:** HMAC SHA-256 verified against `SHOPIFY_API_SECRET` using timing-safe comparisons (`crypto.timingSafeEqual`).
2. **Audience (`aud`):** Matches the app's configured Shopify client ID (`SHOPIFY_API_KEY`).
3. **Issuer (`iss`) and Destination (`dest`):** Both must point to the identical valid myshopify shop domain (e.g. `https://{shop}.myshopify.com` and `https://{shop}.myshopify.com/admin`).
4. **Shopify Domain Format:** Strictly validated against `/^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/`.
5. **Timestamps:** Verifies `exp` (expiration) and `nbf` (not before) with a 10-second skew window.

---

## 4. Webhook Security & Idempotency State Machine

- **Fail-Closed Execution:** If `SHOPIFY_API_SECRET` is missing, or if HMAC signature verification fails, requests return `401 Unauthorized`.
- **State Machine Idempotency Guard (`WebhookReceipt`):**
  - Tracks `PROCESSING`, `COMPLETED`, and `FAILED` states indexed uniquely by `X-Shopify-Webhook-Id`.
  - **COMPLETED Duplicates:** Safely acknowledged immediately with HTTP 200 without duplicate mutation execution.
  - **FAILED Deliveries:** If a mutation fails (e.g. transient network or DB timeout), the endpoint returns HTTP 500, marking the receipt `FAILED`. Subsequent Shopify retries are allowed to re-enter `PROCESSING` and succeed.
  - **Concurrent PROCESSING Duplicates:** Incoming duplicates while a prior delivery is actively `PROCESSING` within the lock window return HTTP 429 to avoid race conditions without losing the delivery.
  - **Sanitized Failure Metadata:** Error messages stored on failure are sanitized and truncated (PII-free).


---

## 5. PII Minimization & Logging Safety

- **Zero Raw Buyer PII:** Buyer raw email addresses and physical addresses are not stored in the application database. They are passed directly to Shopify's Draft Order.
- **Structured Sanitized Logging:** All server logs pass through `sanitizeForLogging()` which redacts:
  - Email addresses (`[REDACTED_EMAIL]`)
  - Tokens and OAuth codes (`[REDACTED]`)
  - Authorization headers, secrets, and cookies

---

## 6. Public Portal Surface Security

- **Opaque URL Tokens:** Catalogs are exposed only via 256-bit unguessable tokens generated via `crypto.randomBytes(32).toString('hex')`. Sequential or guessable identifiers are never exposed publicly.
- **Rate Limiting:** Public catalog retrieval and pre-submit validation endpoints are rate-limited per IP using a sliding-window rate limiter.
- **Deactivation on Uninstall:** When a merchant uninstalls the app (`app/uninstalled`), public catalog access is disabled immediately (`404 Not Found`).

---

## 7. Order Submission Idempotency State Machine & Ambiguous Failure Reconciliation

- **Pre-Shopify Reservation:** Before dispatching an external `draftOrderCreate` mutation to Shopify, CatalogFlow atomically reserves an `OrderSubmission` record in state `CREATING` indexed uniquely by `@@unique([catalogId, idempotencyKeyHash])`.
  - **First Request:** Atomically claims the key and transitions attempt to `CREATING`. Only the key owner may execute Shopify mutations.
  - **Concurrent Duplicate (`CREATING` < 60s):** Returns `HTTP 409 Conflict` (`CONCURRENT_PROCESSING`) without sending another GraphQL request to Shopify.
  - **Completed Duplicate (`COMPLETED`):** Returns the exact existing submission payload (`isDuplicate: true`) with zero external Shopify side effects.
  - **Failed Attempt (`FAILED`):** Safe retry allowed to re-enter `CREATING`.
- **Deterministic Correlation Tag & Shopify Reconciliation:**
  - Every Draft Order created by CatalogFlow includes a deterministic, non-PII tag: `cf-sub:<submissionId>`.
  - On retry after an ambiguous failure (e.g. status is `CREATING` after timeout or `REQUIRES_RECONCILIATION`):
    - CatalogFlow queries Shopify via GraphQL Admin API (`query: tag:cf-sub:<submissionId>`).
    - If found: Recovers existing Draft Order ID and name, transitions local submission to `COMPLETED`, and returns the order.
    - Zero duplicate Draft Orders are created in Shopify.

---

## 8. Catalog Membership Authorization

- **Strict Source Enforcement:** Prior to live revalidation, the server resolves the exact allowed product set for the catalog (`resolveCatalogAllowedProductGids`) from explicit product sources and active collection memberships.
- **Out-of-Catalog Variant Rejection:** If an incoming order contains variant GIDs not belonging to the catalog's allowed active products, the entire request is rejected with `HTTP 422` (`INVALID_LINES`).
- **Zero Cross-Catalog Discounts:** Wholesale discounts are never applied to unauthorized variants, preventing catalog bypass attacks.

---

## 9. dataVersion Submit-Time Boundary Enforcement

- Every catalog configuration change (discounts, name, sourced collections, added/removed products) increments `dataVersion`.
- The buyer submission payload requires `dataVersion`. If `submitted.dataVersion !== catalog.dataVersion`, the request is rejected with `HTTP 409` (`CATALOG_CHANGED`), requiring the buyer to reload and review updated pricing/catalog rules before submitting.

---

## 10. Concurrency-Safe Quota Slot Reservation & Billing Period Lifecycle

- **30-Day Cycle Rollover:** The 30-day billing cycle anchor (`billingCycleAnchor`) is automatically evaluated before checking quota. When the 30-day period expires, `monthlySubmissionsCount` is atomically reset to 0 and the anchor is advanced.
- **Atomic Slot Reservation:** Quota slots are reserved before external mutations using atomic conditional SQL updates:
  ```sql
  UPDATE "Shop"
  SET "monthlySubmissionsCount" = "monthlySubmissionsCount" + 1
  WHERE "id" = $shopId AND "monthlySubmissionsCount" < $limit
  ```
  Eliminates TOCTOU race conditions near the plan limit.
- **Failure Reclamation:** If a submission fails before external Shopify side effects, the reserved quota slot is immediately reclaimed via atomic decrement.

---

## 11. Public Token & PII Isolation in Draft Order Metadata

- Draft Order custom attributes include strictly operational non-PII metadata:
  - `Business Name`
  - `Catalog`
  - `Catalog ID`
  - `PO Number`
  - `Submission Reference` (`CatalogFlow-Submission:<submissionId>`)
- **Strict Exclusion:** The public catalog token (`publicToken`) and raw `Idempotency-Key` are strictly excluded from Shopify Draft Order metadata and tags.

