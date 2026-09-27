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

---

## 12. Hashed Bucket IP Rate Limiting (M9.2)

- **Non-Reversible Hashed Keys:** To comply with privacy standards and prevent raw IP persistence, rate-limiting buckets use SHA-256 HMAC-style hashed keys:
  `sha256(rawIp + ':' + routeCategory + ':' + publicToken)`
- **Isolated Buyer Buckets:** Distinct bucket scoping prevents an abusive client on one catalog from exhausting quotas for other wholesale buyers.
- **Tiered Endpoint Capacities:**
  - `GET /api/public/catalog/:token`: 120 req/min
  - `POST /api/public/catalog/:token/validate`: 60 req/min
  - `POST /api/public/catalog/:token/submit`: 30 req/min
  - `POST /api/public/catalog/:token/event`: 60 req/min
- **Standard Headers:** Returns `Retry-After`, `X-RateLimit-Limit`, and `X-RateLimit-Remaining` headers on all responses.

---

## 13. Input Bounds & DoS Protection (M9.3)

- **Line Count Cap:** Orders are strictly bounded to a maximum of 500 lines per submission.
- **Quantity Cap:** Line item quantities are validated between `1` and `100,000` units.
- **String Length Limits:** Buyer fields enforce strict string length bounds (`businessName` <= 150, `email` <= 150, `poNumber` <= 50, `note` <= 1000).

---

## 14. Fail-Fast Environment Validation (M9.16)

- On application launch (`server.ts` and `worker.ts`), `validateEnvironment()` validates:
  - `DATABASE_URL`: Must be present and a valid URL.
  - `ENCRYPTION_SECRET`: Must be a valid non-placeholder string of at least 32 characters.
  - In `NODE_ENV === 'production'`: Validates `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, and `HOST`/`SHOPIFY_APP_URL`.
- Any missing or invalid production requirement aborts initialization immediately.

---

## 15. Shopify Protected Customer Data (PCD) Level 2 Compliance

### A. Data Minimization & Zero-Persistence Architecture
CatalogFlow requests strictly **one** protected customer field: **`email`**. CatalogFlow has **no runtime dependency** on and never requests buyer names, phone numbers, physical addresses, shipping addresses, or billing addresses.
- **Zero Persistent DB Retention:** Raw buyer email addresses, business names, PO numbers, and buyer notes are **never persisted at rest** in CatalogFlow's PostgreSQL database.
- **Transient Processing:** Buyer form inputs exist in server memory solely during the lifecycle of the HTTP request to dispatch the Shopify Admin `draftOrderCreate` mutation.
- **Operational Records Only:** Database records in `OrderSubmission`, `AnalyticsEvent`, `BackgroundJob`, `WebhookReceipt`, and `RuntimeIncident` store non-PII operational numbers and references only.

### B. Automated Data Retention Schedule
Enforced automatically by `src/services/retention.server.ts` and scheduled to run every 24 hours via the background worker:
- **Raw Buyer PCD (Email, Business Name, PO, Notes):** 0 days (transient in-memory only).
- **RuntimeIncident Records:** 30-day retention cutoff.
- **WebhookReceipt Records:** 30-day retention cutoff.
- **BackgroundJob (Terminal states: COMPLETED / FAILED):** 14-day retention cutoff.
- **AnalyticsEvent Records:** 90-day retention cutoff.
- **PcdAccessAudit Records:** 90-day retention cutoff.
- **OrderSubmission & Snapshots:** Retained during active merchant installation as operational history (zero buyer PII).
- **Complete Shop Purge:** Executed permanently upon receipt of verified `shop/redact` webhook.

### C. Data Loss Prevention (DLP) & Deep Redaction
- Centralized in `src/services/security.server.ts` via `redactSensitiveString()` and `sanitizeForLogging()`.
- Strips email addresses, Bearer tokens, Shopify access tokens (`shpat_`, `shppat_`, `shpca_`, etc.), database credentials, PO numbers, passwords, and secrets across all logging streams (`logger.info`, `logger.warn`, `logger.error`), error messages (`sanitizeErrorMessage()`), and incident storage.
- Logger prevents raw `error.message`, `error.stack`, or `error.cause` from bypassing redaction.

### D. PCD Access Audit Logging
- Dedicated `PcdAccessAudit` model preserves a zero-PII chronological audit trail of all protected customer data access operations:
  - `BUYER_EMAIL_PROCESSED_FOR_DRAFT_ORDER`: Recorded at the server-side point of Draft Order mutation dispatch.
  - `CUSTOMERS_DATA_REQUEST_RECEIVED`: Recorded upon receiving Shopify compliance webhook.
  - `CUSTOMERS_REDACT_RECEIVED`: Recorded upon receiving Shopify compliance webhook.
  - `SHOP_REDACT_RECEIVED` & `SHOP_DATA_PURGED`: Recorded upon receiving and completing store data erasure.
- Indexed by `[shopId]`, `[createdAt]`, and `[shopId, createdAt]` with automated 90-day retention.

### E. Test & Production Environment Isolation
- `src/db.ts` enforces `validateDatabaseEnvironmentForContext()`:
  - Supports `TEST_DATABASE_URL` for isolated test databases.
  - Rejects tests attempting to execute against a designated production database (`PRODUCTION_DATABASE_URL` or `PRODUCTION_DB_HOST`).
  - Production and test encryption secrets are strictly separated.

### F. Encrypted Backup Architecture & Security Policy
- **Architectural Property:** Because buyer PCD is never stored at rest, raw buyer PCD never enters database backups.
- **SafeMerge-Adapted Encrypted Backup Architecture:**
  - **Connection:** TLS-secured connection directly to Hostless PostgreSQL using `DATABASE_BACKUP_URL` (strictly refuses fallback to `DATABASE_URL`).
  - **Execution:** Scheduled via GitHub Actions (`.github/workflows/database-backup.yml`) running daily at 00:00 UTC and on-demand via `workflow_dispatch`.
  - **Custom Dump:** Executes `pg_dump --format=custom --no-owner --no-privileges` to temporary storage (`RUNNER_TEMP`).
  - **AES-256-GCM Authenticated Encryption:** Encrypts dump using a 32-byte Base64 key (`BACKUP_ENCRYPTION_KEY`), generating a cryptographically random 12-byte IV per backup, an authenticated 16-byte tag, and a structured envelope (`scripts/backup-crypto.ts`).
  - **Guaranteed Plaintext Cleanup:** Plaintext dump is deleted in a `finally` block under all circumstances (success, encryption failure, or pg_dump crash). Plaintext dumps never enter artifact storage.
  - **Private Artifact Storage:** GitHub Actions uploads exclusively `*.dump.enc` artifacts with a 14-day retention cutoff.
  - **Safe Decryption & Restore (`scripts/restore-database.ts`):** Requires `RESTORE_DATABASE_URL` (never falls back to production URLs) and `BACKUP_ENCRYPTION_KEY`. Authenticates the envelope before executing `pg_restore`. Enforces a production safety guard requiring explicit `ALLOW_PRODUCTION_RESTORE=true` to prevent accidental overwrites. Plaintext decrypted dumps are immediately deleted in a `finally` block.
  - **Operational Status:** Operational readiness requires: (1) GitHub secrets `DATABASE_BACKUP_URL` and `BACKUP_ENCRYPTION_KEY` configured in repository, (2) successful test workflow run producing an encrypted artifact, (3) verified restore test of an encrypted artifact into a non-production test database.

### G. Staff Access & Least Privilege Policy
- Production database and infrastructure access is strictly restricted to authorized primary operator(s).
- Shared accounts are strictly prohibited.
- Support staff do not browse buyer PII because buyer PII is not stored.
- Production data must never be downloaded to local developer workstations.
- Production data must never be shared in external AI prompts, public issues, or screenshots.

### H. Strong Authentication & MFA Policy
- All operators accessing the Shopify Partner Dashboard, Hostless hosting, Git repositories, and production email must use unique passwords of at least 16 characters managed by a password manager.
- Multi-Factor Authentication (MFA / passkey / TOTP) is mandatory across all administrative accounts.

### I. Security Incident Response
- Formal procedures for triage, containment, token revocation, forensic preservation, and Shopify/merchant notifications are documented in [SECURITY_INCIDENT_RESPONSE.md](file:///d:/b2b-catalog/SECURITY_INCIDENT_RESPONSE.md).

