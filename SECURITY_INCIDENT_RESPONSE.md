# CatalogFlow Security Incident Response Policy

**Effective Date:** September 2026  
**Document Owner:** CatalogFlow Security & Operations  
**Scope:** CatalogFlow B2B Order Catalog (Shopify Embedded App)

---

## 1. Incident Severity Classification

Security incidents are categorized based on impact to merchant operations, platform integrity, and potential exposure of credentials or protected customer data (PCD):

| Severity | Definition | Examples | SLA / Response Target |
| :--- | :--- | :--- | :--- |
| **Critical (SEV-1)** | Active compromise of application infrastructure, leakage of Shopify Partner API secrets or merchant access tokens, unauthorized access to Shopify APIs, or systemic outage. | Server breach, exposed `SHOPIFY_API_SECRET`, exposed database credentials, active data exfiltration. | Immediate triage (< 1 hour); containment within 4 hours. |
| **High (SEV-2)** | Significant vulnerability or failure of protective controls without confirmed exfiltration; failure of HMAC verification on webhook endpoints; multi-tenant isolation defect. | Webhook verification bypass, rate-limiting failure under active attack, failure of token encryption at rest. | Initial triage within 2 hours; containment within 12 hours. |
| **Medium (SEV-3)** | Localized security anomaly, transient verification failures, minor dependency vulnerability with no active exploit path, or non-sensitive log pollution. | High-volume failed login/HMAC attempts, low-severity CVE in non-runtime devDependency. | Triage within 24 hours; resolution within standard sprint cycle. |
| **Low (SEV-4)** | Informational security inquiries, minor documentation discrepancies, or cosmetic security warnings. | Outdated documentation reference, public header hygiene refinement. | Reviewed during weekly maintenance. |

---

## 2. Detection & Reporting

Incidents are identified and reported via:
- Automated runtime error reporting and operational alerts (`RuntimeIncident` table monitoring).
- Shopify Partner Dashboard security alerts or webhooks.
- Inbound vulnerability notifications via `security@b2b-catalog.hostless.app`.
- Routine automated dependency scans and CI audit checks.

---

## 3. Immediate Containment

Upon identification of a SEV-1 or SEV-2 incident, the designated incident response operator immediately executes containment procedures:
1. **Isolate Compute:** Temporarily pause traffic or restrict worker processing if an active compromise is suspected.
2. **IP / Route Blocking:** Enforce network-level IP blocking or path restriction via proxy/firewall controls.
3. **Database Access Lockdown:** Revoke any compromised database roles or rotate connection credentials immediately.

---

## 4. Credential & Token Revocation

When token or credential compromise is suspected, operators must follow a differentiated rotation procedure rather than blindly modifying global keys:

1. **Shopify API Secret & Partner Token Rotation:** If `SHOPIFY_API_SECRET` or `SHOPIFY_PARTNER_API_ACCESS_TOKEN` is compromised, immediately rotate secrets within the Shopify Partner Dashboard and update production environment variables.
2. **Merchant Access Token Revocation & Reauthorization:** If offline merchant access tokens are suspected of compromise, initiate OAuth re-authorization across impacted merchant stores to revoke old credentials in Shopify and issue fresh tokens.
3. **Database Credential Rotation:** Rotate `DATABASE_URL` credentials in cloud database hosting settings (Hostless) and update production instance configurations.
4. **Application Encryption-Key Compromise (`ENCRYPTION_SECRET`):** Operators must **NOT** blindly rotate the encryption secret without preparation, as doing so would render existing stored encrypted tokens undecryptable. Instead, follow a controlled procedure:
   - Execute a controlled migration script that reads existing records, decrypts with the old key, re-encrypts with the new key in an atomic database transaction, and then switches `ENCRYPTION_SECRET`.
   - If migration is not feasible, force an administrative reauthorization requiring merchants to re-authenticate via OAuth to populate fresh encrypted tokens under the new key.

---

## 5. Shopify Access Token & API Secret Response

Because CatalogFlow operates as an embedded Shopify application:
- **Shopify Security Reporting:** If Shopify credentials or access tokens are compromised, notify Shopify Security promptly via the Partner Dashboard security contact channel or [Shopify Security](https://www.shopify.com/security).
- **Merchant Re-Authentication:** Force OAuth re-authorization across impacted merchant stores to revoke potentially tainted tokens.
- **Revocation Verification:** Validate that old tokens are rejected by Shopify Admin GraphQL APIs.

---

## 6. Preservation of Logs & Forensic Evidence

Before altering or redeploying systems during an active investigation:
1. **Preserve System Logs:** Snapshot stdout/stderr application logs, reverse proxy access logs, and database query logs.
2. **Preserve Audit Trails:** Freeze `PcdAccessAudit`, `RuntimeIncident`, and `WebhookReceipt` tables to maintain chronological proof of events.
3. **Chain of Custody:** Store forensic artifacts in read-only, access-restricted storage with cryptographic hashing (SHA-256).

---

## 7. Scope Assessment

Determine the exact boundaries of the incident:
- **Affected Shops:** Identify specific Shopify domains impacted using shop-scoped audit logs (`shopId` / `shopDomain`).
- **Affected Systems:** Identify whether web tier, background worker, database, or external webhook ingress was involved.
- **Affected Data:** 
  - CatalogFlow does not persist raw buyer email, buyer names, phone numbers, or addresses.
  - Assess whether merchant catalog data, encrypted tokens, or operational submission IDs were accessed.

---

## 8. Remediation

1. Address the root cause in code or infrastructure configuration.
2. Apply minimal, verified security patches with regression tests.
3. Verify that all automated tests, linting, and Shopify compliance validations pass cleanly.
4. Deploy the fix via zero-downtime rolling deployment.

---

## 9. Merchant, Shopify & Legal Notification Assessment

1. **Shopify Notification:** When a security incident involves Shopify credentials, APIs, merchant tokens, or Protected Customer Data that requires notification, notify Shopify promptly and without undue delay via official Shopify security channels and the Partner Dashboard.
2. **Merchant Notification:** If a merchant's shop data or wholesale operations were impacted, notify the affected merchant's primary store contact with factual details, remediation steps taken, and guidance.
3. **Regulatory Evaluation:** Assess whether applicable data protection regulations (e.g. GDPR, CCPA/CPRA) require formal notification based on the specific facts of the incident and applicable legal standards. Note that CatalogFlow's zero-persistence buyer PCD architecture significantly mitigates personal data breach risk.

---

## 10. Recovery & Verification

1. Verify system integrity, database health, and rate limiter status.
2. Confirm webhook ingress and Draft Order submission pipelines are functioning normally.
3. Monitor `RuntimeIncident` and error logs for heightened vigilance following remediation.

---

## 11. Post-Incident Review (PIR)

Within 5 business days of incident resolution, the incident responder must conduct a blameless Post-Incident Review:
- Construct an exact timeline of events from detection to recovery.
- Identify root cause and contributing factors.
- Review effectiveness of containment and response procedures.
- Formulate concrete preventive action items with assigned owners and deadlines.
- Archive the PIR document securely for compliance auditing.

---

## 12. Emergency Contact Mechanism

- **Designated Privacy & Data Protection Contact:** Configured operational email (must be verified prior to production launch; defaults to configured `SUPPORT_EMAIL`).
- **Shopify Security Inquiries:** Prompt notification via Shopify Partner Dashboard or [Shopify Security Contact](https://www.shopify.com/security).
- **Merchant Support Inquiries:** Accessible via the configured application support channel.
