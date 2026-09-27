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
| `SHOPIFY_PARTNER_ORG_ID` | Production | Shopify Partner Organization ID for authoritative Partner API billing |
| `SHOPIFY_PARTNER_APP_ID` | Production | Shopify Partner App ID for authoritative Partner API billing |
| `SHOPIFY_PARTNER_API_ACCESS_TOKEN` | Production | Secret Partner API access token (`shppat_...`) |
| `SHOPIFY_APP_HANDLE` | Optional | Partner Dashboard app handle (default: `catalogflow-b2b-order-catalog`) |
| `DATABASE_BACKUP_URL` | Backups | Dedicated database URL for running encrypted backups (never falls back to `DATABASE_URL`) |
| `BACKUP_ENCRYPTION_KEY` | Backups | 32-byte Base64 key for AES-256-GCM backup encryption and restore |
| `RESTORE_DATABASE_URL` | Restore | Target database URL for backup restoration (never falls back to production URLs) |
| `ALLOW_PRODUCTION_RESTORE`| Restore | Explicit guard flag (`true`) required to restore into a production database |
| `TEST_DATABASE_URL` | Optional | Dedicated isolated database URL for test runners |
| `PRODUCTION_DATABASE_URL`| Optional | Explicit production DB URL guard against accidental test execution |
| `PORT` | Optional | Web server port (default: 3000) |
| `NODE_ENV` | Optional | `development`, `test`, or `production` |

---

## 7. Protected Customer Data (PCD) Level 2 Operational Runbook

### A. Data Minimization & Storage Architecture
- CatalogFlow requests strictly one protected customer field: **Buyer Email**.
- Raw buyer emails, business names, PO numbers, and buyer notes are **never persisted at rest** in the PostgreSQL database.
- Data exists transiently in server memory only during the lifecycle of the HTTP request to create the Shopify Draft Order.

### B. Automated Retention Enforcement
Data retention is enforced automatically by `enforceDataRetention()` in `src/services/retention.server.ts`, executed by the background worker every 24 hours:
- `RuntimeIncident`: 30-day retention.
- `WebhookReceipt`: 30-day retention.
- `BackgroundJob` (terminal `COMPLETED` / `FAILED`): 14-day retention.
- `AnalyticsEvent`: 90-day retention.
- `PcdAccessAudit`: 90-day retention.
- `OrderSubmission`: Retained during active installation (operational history, zero raw PII).
- Manual on-demand enforcement can be invoked via CLI:
  ```bash
  node -e "import('./dist/services/retention.server.js').then(m => m.enforceDataRetention()).then(console.log)"
  ```

### C. PCD Access Audit Trails
- Audit events are recorded in `PcdAccessAudit`:
  - `BUYER_EMAIL_PROCESSED_FOR_DRAFT_ORDER`: Transient processing of buyer email for Draft Order creation.
  - `CUSTOMERS_DATA_REQUEST_RECEIVED`: Acknowledged data request compliance webhook.
  - `CUSTOMERS_REDACT_RECEIVED`: Acknowledged customer redact compliance webhook.
  - `SHOP_REDACT_RECEIVED` / `SHOP_DATA_PURGED`: Complete purge of shop records upon uninstall.
- Audit records store zero buyer PII and have an automated 90-day retention cutoff.

### D. Test / Production Isolation
- Automated test suites (`vitest`) strictly prioritize `TEST_DATABASE_URL` over `DATABASE_URL`.
- The database environment guard `validateDatabaseEnvironmentForContext()` refuses test execution if the connection string matches a known production database or production-designated hostname.

### E. Encrypted Backup Architecture & Disaster Recovery Runbook
- **Zero PCD in Backups:** Because buyer PCD is never persisted at rest, database backups contain zero buyer PCD.
- **Workflow Automation:** GitHub Actions runner executes `.github/workflows/database-backup.yml` daily at 00:00 UTC and on-demand via `workflow_dispatch`.
- **Backup Execution:**
  ```bash
  DATABASE_BACKUP_URL="<db_url>" BACKUP_ENCRYPTION_KEY="<base64_32_byte_key>" npm run backup:database
  ```
  - Takes a custom-format dump (`pg_dump --format=custom`).
  - Encrypts using AES-256-GCM authenticated envelopes (`scripts/backup-crypto.ts`).
  - Guaranteed deletion of plaintext `.dump` in a `finally` block.
  - Emits `catalogflow-backup-<timestamp>-<hash>.dump.enc` into `backups/`.
  - Artifacts stored in GitHub Actions private artifact store for 14 days.
- **Safe Disaster Recovery Restore:**
  ```bash
  RESTORE_DATABASE_URL="<target_url>" BACKUP_ENCRYPTION_KEY="<key>" npm run restore:database backups/catalogflow-backup-....dump.enc
  ```
  - Authenticates and decrypts the envelope *before* invoking `pg_restore`.
  - Refuses restore to production databases unless `ALLOW_PRODUCTION_RESTORE=true` is explicitly provided.
  - Guaranteed deletion of decrypted plaintext dump in a `finally` block.
- **Operational Sign-off Checklist:**
  The backup system must not be claimed operational until the operator completes:
  1. Set `DATABASE_BACKUP_URL` and `BACKUP_ENCRYPTION_KEY` in GitHub Repository Secrets.
  2. Trigger manual `workflow_dispatch` on `database-backup.yml` and verify an encrypted `.dump.enc` artifact is produced.
  3. Download the artifact and execute a test restore against a non-production test PostgreSQL database (`RESTORE_DATABASE_URL`) to verify end-to-end data integrity.

### F. Staff Access & Authentication Policy
- Production database and infrastructure access is strictly restricted to authorized primary operator(s) on a least-privilege basis.
- Production data is never downloaded to local workstations.
- All operators must enforce passwords of $\ge 16$ characters via a password manager and Multi-Factor Authentication (MFA / passkey) across Shopify Partner Dashboard, Hostless, GitHub, and production email.

### G. Security Incident Response
- Immediate response protocol, token revocation, forensic preservation, and notification procedures are detailed in [SECURITY_INCIDENT_RESPONSE.md](file:///d:/b2b-catalog/SECURITY_INCIDENT_RESPONSE.md).
