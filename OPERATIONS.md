# CatalogFlow: Operations & Production Runbook

This document details the operational architecture, health monitoring, background job system, data synchronization, and merchant troubleshooting procedures for **CatalogFlow: B2B Buyer Ordering Portal**.

---

## 1. Web vs Worker Architecture

CatalogFlow runs as two decoupled processes sharing a common PostgreSQL database:

```
                  +-------------------------+
                  |  Shopify Admin / Buyer  |
                  +------------+------------+
                               | HTTPS
                               v
                  +-------------------------+
                  |     Web Application     |
                  |     (src/server.ts)     |
                  +------------+------------+
                               |
               +---------------+---------------+
               | Fast Webhooks / Mutations     |
               v                               v
    +--------------------+           +--------------------+
    | WebhookReceipt     |           | BackgroundJob      |
    | (State Machine)    |           | (PostgreSQL Queue) |
    +--------------------+           +---------+----------+
                                               ^
                                               | FOR UPDATE SKIP LOCKED
                                     +---------+----------+
                                     |  Background Worker |
                                     |   (src/worker.ts)  |
                                     +--------------------+
```

### Processes:
1. **Web Server (`src/server.ts`)**:
   - Handles public buyer catalog requests, line item validations, and orders.
   - Serves embedded merchant Shopify admin interface.
   - Receives Shopify webhooks, validates HMAC, records receipts, and quickly returns 200 OK after enqueueing jobs.
   - Run command: `npm run start` or `npm run dev`.

2. **Background Worker (`src/worker.ts`)**:
   - Standalone daemon continuously polling `BackgroundJob` table.
   - Executes product and collection synchronizations asynchronously.
   - Handles retries with exponential backoff and safely drops jobs for uninstalled stores.
   - Run command: `npm run worker` or `npm run worker:prod`.

---

## 2. Health & Readiness Probes

The web application exposes standard HTTP health and readiness endpoints for Docker/Kubernetes container orchestrators:

| Endpoint | Method | Purpose | Response Format | Success Code | Failure Code |
|---|---|---|---|---|---|
| `/health` | `GET` | Liveness check (process running) | `{"status": "ok", "uptime": 124, "timestamp": "..."}` | `200` | N/A |
| `/ready` | `GET` | Readiness check (database reachable) | `{"status": "ready", "database": "connected", "timestamp": "..."}` | `200` | `503` |

### Probing with cURL:
```bash
# Check service liveness
curl -f http://localhost:3000/health

# Check database connectivity
curl -f http://localhost:3000/ready
```

---

## 3. Background Job Queue & Lifecycle

The persistent PostgreSQL job queue uses row-level locking via `SELECT ... FOR UPDATE SKIP LOCKED`:

```
+------------+       claimNextJob()       +--------------+
|  PENDING   | ------------------------> |  PROCESSING  |
+------------+                            +-------+------+
      ^                                           |
      | Exponential Backoff (attempts < max)      |
      +-------------------------------------------+
      |                                           |
      v (attempts >= max)                         v (Success)
+------------+                             +--------------+
|   FAILED   |                             |  COMPLETED   |
+------------+                             +--------------+
```

### Key Safety Invariants:
- **Locking**: Workers never block each other on claims due to `SKIP LOCKED`.
- **Stale Job Recovery**: Crashed worker jobs left in `PROCESSING` are automatically recovered to `PENDING` after 5 minutes.
- **Circuit Breaker**: Poisoned jobs exceeding `maxAttempts` (default: 5) transition to `FAILED` with sanitized error details, preventing infinite worker loops.
- **Uninstalled Store Protection**: Jobs targeting shops with `uninstalledAt IS NOT NULL` are safely dropped as `COMPLETED` without executing mutations or hitting Shopify.

---

## 4. Submission Reconciliation Runbook

When a network drop, timeout, or ambiguity occurs during Shopify Draft Order creation, the submission transitions to `REQUIRES_RECONCILIATION`.

### Reconciliation Safety Guarantee:
- The system **NEVER** automatically calls `draftOrderCreate` upon an empty search result.
- A submission can only be reconciled by finding a matching Draft Order tagged with `cf-sub:<submissionId>`.
- If found: Marks submission `COMPLETED` and emits North Star metric event.
- If not found: Remains in `REQUIRES_RECONCILIATION` until verified. Duplicate orders are physically impossible.

### Merchant Self-Service Action:
1. Open the merchant admin portal at `/` (App Bridge).
2. Navigate to **Orders / Submissions**.
3. For any submission in `REQUIRES_RECONCILIATION`, click the **"Check Shopify ↻"** button.
4. The API queries Shopify GraphQL for `tag:cf-sub:<submissionId>`.
5. If Shopify has created the draft, status instantly updates to `COMPLETED` with a link to `#D...`.

---

## 5. Sync Troubleshooting Runbook

### Case 1: Products Not Appearing in Public Catalog
1. Check that the catalog is in `PUBLISHED` status.
2. Confirm the collection or product GID matches the active source in Shopify.
3. Check `SyncRun` table for the store:
   ```sql
   SELECT id, type, status, "startedAt", "finishedAt", "statsJson"
   FROM "SyncRun"
   WHERE "shopId" = '<shop_id>'
   ORDER BY "startedAt" DESC LIMIT 5;
   ```
4. If a sync failed, trigger manual sync from the merchant portal or API:
   ```bash
   POST /api/admin/sync/manual
   Authorization: Bearer <session_token>
   ```

### Case 2: Webhooks Not Ingesting
1. Verify `SHOPIFY_API_SECRET` matches your Shopify Partner App credentials.
2. Check `WebhookReceipt` table for failed attempts:
   ```sql
   SELECT "webhookId", topic, status, attempts, "lastError"
   FROM "WebhookReceipt"
   WHERE status = 'FAILED'
   ORDER BY "processedAt" DESC LIMIT 10;
   ```
3. Check `BackgroundJob` table for worker backlog:
   ```sql
   SELECT id, type, status, attempts, "availableAt", "lastError"
   FROM "BackgroundJob"
   WHERE status IN ('PENDING', 'FAILED')
   ORDER BY "createdAt" DESC LIMIT 10;
   ```

---

## 6. Environment Configuration Reference

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `ENCRYPTION_SECRET` | Yes | 32+ character key for AES-256-GCM token encryption |
| `SHOPIFY_API_KEY` | Production | Shopify App Client ID |
| `SHOPIFY_API_SECRET` | Production | Shopify App Client Secret for HMAC and JWT verification |
| `HOST` / `SHOPIFY_APP_URL` | Production | Fully qualified public HTTPS URL of application |
| `PORT` | Optional | Web server port (default: 3000) |
| `NODE_ENV` | Optional | `development`, `test`, or `production` |
