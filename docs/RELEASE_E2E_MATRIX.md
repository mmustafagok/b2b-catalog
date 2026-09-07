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
| **M10.12** | Shopify App Pricing Setup | **PASS** | Starter ($14.99/mo, 50 orders), Growth ($29.99/mo, 250 orders), Scale ($49.99/mo, 1000 orders) with 7-day trials. Zero usage overages. |
| **M10.13** | Billing Entitlement Sync | **PASS** | `BillingProvider` acts as single authority. `Shop.plan` functions as synchronized mirror. Direct client DB plan mutations strictly blocked in production. |
| **M10.14** | Downgrade Safety | **PASS** | Downgrading validates active catalog and variant counts against target plan limits. Does not destructively delete merchant data. |
| **M10.15** | Commercial Funnel Analytics | **PASS** | Tracks `catalog_viewed`, `order_summary_started`, `order_submitted`, and North Star `draft_order_created`. Non-blocking DB recording. |
| **M10.16** | Privacy & Minimal PII Retention | **PASS** | Zero buyer PII (email, notes, PO) persisted to database on successful submission. Data flows straight to Shopify Draft Order. Compliance webhooks supported. |
| **M10.17** | Uninstall / Reinstall Lifecycle | **PASS** | Uninstall deactivates shop, disables buyer links, and drops queued jobs. Reinstall reactivates shop, refreshes tokens, and reconciles state. |
| **M10.18** | Deployment Architecture | **PASS** | Railway Web + Railway Worker daemon + PostgreSQL. Configured `app.set('trust proxy', 1)` for safe IP resolution and hashed bucket rate limiting. |
| **M10.19** | App Store Review Self-Audit | **PASS** | Full self-audit against Shopify App Store guidelines: 0 Failures, 0 Needs Review. |
| **M10.20** | Quality & Verification Gates | **PASS** | `npm test` 143/143 tests passing. `npm run typecheck` 0 errors. `npm run build` clean. `npx prisma validate` & migrations up to date. |
