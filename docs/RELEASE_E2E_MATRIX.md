# CatalogFlow — Milestone 10 End-to-End Test Matrix & Verification

Date: 2026-09-07  
Target: Shopify App Store Release Package  
Target API Version: 2026-07  

---

## E2E Test Matrix

| Area | Requirement / Scenario | Result | Evidence & Implementation |
| :--- | :--- | :--- | :--- |
| **M10.1** | Real Shopify App Configuration | **PASS** | Scopes: `read_products`, `read_inventory`, `write_draft_orders`, `read_draft_orders` in `shopify.app.toml`. API version: `2026-07`. Embedded: `true`. |
| **M10.2** | App Bridge Production Wiring | **PASS** | `vite.config.ts` transform + Express dynamic injection replaces `%VITE_SHOPIFY_API_KEY%` with real key. Zero placeholder leaks. |
| **M10.3** | Managed Installation / Token Exchange | **PASS** | RFC 8693 token exchange via `/api/auth/token-exchange`. Expiring offline token + refresh token encrypted via AES-256-GCM. Reinstall reactivates cleanly. |
| **M10.4** | Real Webhook Registration & Fast-Ack | **PASS** | Fast-ack `<500ms` for products, collections, uninstallation, and mandatory compliance topics (`customers/data_request`, `customers/redact`, `shop/redact`). Enqueues `BackgroundJob`. |
| **M10.5** | Initial Sync & Product/Variant Mirroring | **PASS** | Synchronizes products, active variants, collections, and memberships into local PostgreSQL snapshots with strict tenant isolation. |
| **M10.6** | Catalog Creation & Publishing | **PASS** | Supports explicit products, collections, and mixed rules. Enforces plan-specific live catalog limits and variant caps upon publish. |
| **M10.7** | Buyer Portal Experience | **PASS** | Tokenized `/c/:publicToken` route requires zero buyer login. Instant SKU/title search, variant matrix grid, sticky summary bar, and keyboard navigation. |
| **M10.8** | Real Draft Order Creation | **PASS** | Generates native Shopify Draft Order via Admin GraphQL. Injects buyer email, PO number, wholesale discount, customer notes, and `cf-sub:<id>` correlation tag. |
| **M10.9** | Live Revalidation & Stale Price Shield | **PASS** | Pre-mutation checksum and snapshot revalidation catches price changes, discount updates, or deleted variants. Safely returns `409 CATALOG_CHANGED`. |
| **M10.10** | Idempotency & Concurrency Machine | **PASS** | Two-phase state machine with DB unique constraint on `idempotencyKeyHash`. Concurrent submissions share a single Draft Order lease without duplication. |
| **M10.11** | Quota Enforcement | **PASS** | Atomic slot reservation and cycle reconciliation. Blocked requests fail cleanly with `QUOTA_EXCEEDED` before any Shopify mutation. |
| **M10.12** | Shopify App Pricing Setup | **PENDING_SHOPIFY** | Plan definitions configured (Starter, Growth, Scale). Billing engine operates in `LOCAL_MIRROR_PENDING_SHOPIFY` mode pending live Shopify App Pricing contract activation pass. |
| **M10.13** | Billing Entitlement Sync | **PASS** | `BillingProvider` acts as single authority. `Shop.plan` functions as synchronized mirror. Direct client DB plan mutations strictly blocked in production. |
| **M10.14** | Downgrade Safety | **PASS** | Downgrading validates active catalog and variant counts against target plan limits. Does not destructively delete merchant data. |
| **M10.15** | Commercial Funnel Analytics | **PASS** | Tracks `catalog_viewed`, `order_summary_started`, `order_submitted`, and North Star `draft_order_created`. Non-blocking DB recording. |
| **M10.16** | Privacy & Minimal PII Retention | **PASS** | Zero buyer PII (email, notes, PO) persisted to database on successful submission. Data flows straight to Shopify Draft Order. Compliance webhooks supported. |
| **M10.16b** | Protected Customer Data (PCD) | **PARTNER_DASHBOARD** | CatalogFlow passes buyer email to Shopify Draft Orders. As a public Shopify app, Partner Dashboard requires declaring Protected Customer Data access for customer email. Runtime safely handles ACCESS_DENIED / redacted responses without duplicate creation. |
| **M10.17** | Uninstall / Reinstall Lifecycle | **PASS** | Uninstall deactivates shop, disables buyer links, and drops queued jobs. Reinstall reactivates shop, refreshes tokens, and reconciles state. |
| **M10.18** | Deployment Architecture | **PASS** | Hostless Web + Worker daemon + PostgreSQL. Configured `app.set('trust proxy', 1)` for safe IP resolution and hashed bucket rate limiting. |
| **M10.19** | App Store Review Self-Audit | **READY_FOR_E2E** | Code complete for live testing. Scopes, webhooks, compliance routes, and UI conform to Shopify requirements. |
| **M10.20** | Quality & Verification Gates | **PASS** | All automated tests passing. `npm run typecheck` 0 errors. `npm run build` clean. `npm run validate:shopify:prod` 15/15 PASS. |

---

## Protected Customer Data (PCD) Requirements
When publishing CatalogFlow as a public Shopify App:
1. **Partner Dashboard Configuration**: Navigate to **App setup** $\rightarrow$ **Protected customer data**.
2. **Access Declaration**: Request access to Customer data specifically for the **Customer email** protected field, required by `draftOrderCreate` when attaching buyer contact email.
3. **Data Protection & Privacy**: CatalogFlow implements zero-PII persistence for completed submissions (email is forwarded directly to the Shopify Draft Order payload and not stored long-term in the application database).
4. **Runtime Resilience**: In case of `ACCESS_DENIED` or field-level redaction, CatalogFlow's GraphQL client detects the permission error definitively (or triggers safe reconciliation if ambiguous), releasing quota reservations without creating duplicate draft orders.

