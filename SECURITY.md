# Security & Compliance Model: CatalogFlow

This document outlines the multi-layered security and compliance architecture implemented in CatalogFlow.

---

## 1. Access Token Protection at Rest

- **Algorithm:** Authenticated AES-256-GCM (`aes-256-gcm`).
- **Initialization Vector:** Unique cryptographically random 12-byte (96-bit) IV generated per encryption event.
- **Authentication Tag:** 16-byte (128-bit) GCM authentication tag verifies payload integrity and authenticity.
- **Envelope Format:** Versioned storage string: `enc:v1:<iv_hex>:<authTag_hex>:<ciphertext_hex>`.
- **Key Management:** Derived deterministically from `ENCRYPTION_SECRET` via SHA-256 (32 bytes). Never committed to version control.
- **Safe Failure:** Tampered payloads or incorrect keys throw a strict `CryptoError` preventing unauthorized token use.

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

## 4. Webhook Security & Idempotency

- **Fail-Closed Execution:** If `SHOPIFY_API_SECRET` is missing, or if HMAC signature verification fails, requests return `401 Unauthorized`.
- **Idempotency Guard:** Uses `WebhookReceipt` indexed by `X-Shopify-Webhook-Id`. Duplicate deliveries are acknowledged immediately with HTTP 200 without executing duplicate database mutations.

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
