**B2B CATALOG**

**Buyer Ordering Portal**

Shopify products → live wholesale catalog → bulk variant/qty order → Shopify Draft Order


> [!NOTE]
> **BUILD KARARI: BUILD — 8.2/10**
> Olgunlaştırılmış yön: “PDF catalog maker” değil, alıcının sipariş verdiği canlı B2B ordering surface. Katalog ürün değil; sipariş toplama arayüzü. V1’in kazanan wedge’i: no-login paylaşılabilir katalog + hızlı variant/qty sipariş + Shopify Draft Order + güvenilir canlı senkron.



| **Boyut** | **Karar** |
| --- | --- |
| Çalışma adı | B2B Catalog / Buyer Ordering Portal (brand daha sonra) |
| ICP | Shopify’da wholesale/B2B satan, 30–5.000 SKU/variant ölçeğinde küçük-orta merchant |
| Ana JTBD | Buyer’ların ürünleri hızlı görüp varyant/adet seçmesi; merchant’ın Excel/WhatsApp/mail siparişini elle Shopify’a girmemesi |
| V1 yüzeyi | Merchant embedded admin + public buyer catalog URL |
| Order outcome | Buyer submit → Shopify Draft Order |
| MVP hedefi | 7–10 build günü + 2–4 gün hardening/listing |
| Fiyat hipotezi | $14.99 / $29.99 / $49.99; hard caps, no overage |
| 90 günlük hedef | 30–40 paid merchant → yaklaşık $750–$1.2k MRR (hedef, garanti değil) |


Production-ready product scope • market evidence • UX • architecture • schema • API • testing • launch


# 1. Executive Summary


> [!NOTE]
> **Tek cümlelik ürün**
> Merchant Shopify ürünlerinden bir wholesale catalog linki yayınlar; buyer linkten ürünleri arar, varyant/adetleri tek ekranda toplar ve sipariş isteğini gönderir; Safe Catalog bunu Shopify Draft Order’a çevirir.



## 1.1 Neden bu ürün?

- Wholesale buyer davranışı DTC storefront davranışından farklıdır: buyer onlarca SKU/variant ve yüksek adetleri hızlı seçmek ister; ürün sayfası ürün sayfası gezinmek istemez.
- Merchant tarafında alternatif akış genellikle PDF/Excel/CSV/WhatsApp/mail + manuel Shopify order/draft order girişidir. Bu akış stale data, yanlış SKU/qty ve operasyon süresi üretir.
- Pazar kanıtı var: EasyCatalog yüzlerce review’a yaklaşmış; ZINation Catalog & Linesheet Maker $40+/ay fiyat noktasında onlarca review toplamış; hızlı SKU/bulk order araçları da güçlü review sinyali gösteriyor.
- Shopify native B2B 2026’da Basic/Grow/Advanced planlara da genişledi. Bu nedenle “B2B pricing engine” kopyalamak yanlış; ürünün wedge’i buyer-facing ordering UX + paylaşılabilir link + Draft Order otomasyonudur.

## 1.2 Stratejik düzeltme


| **Eski düşünce** | **Olgunlaştırılmış karar** |
| --- | --- |
| PDF catalog generator | Digital buyer ordering portal; PDF P1/P2 yan özellik |
| Katalog = ürün | Katalog = sipariş toplama yüzeyi |
| Template/customization yarışı | Structured, deterministic layout; maksimum 2–3 template |
| Kendi tam B2B fiyat motorumuz | Shopify fiyatını source of truth kabul et; V1’de opsiyonel catalog-wide % discount |
| Merchant admin merkezli | Buyer speed merkezli; merchant admin sadece kurulum/izleme |
| Export başarı metriği | Buyer submission → Draft Order başarı metriği |



> [!NOTE]
> **North Star**
> Successful Buyer Order Submissions → Draft Orders. Activation: merchant 10 dakika içinde ilk live catalog linkini yayınlar ve test submission ile ilk Draft Order’ı görür.



# 2. Market, Demand & Competition


## 2.1 Talep kanıtı


| **Sinyal** | **Gözlem** | **Ne anlatıyor?** |
| --- | --- | --- |
| EasyCatalog | ~194 review, 4.4 rating; catalog/linesheet/wholesale ordering | Catalog workflow’una ödeme yapan köklü merchant tabanı var. |
| ZINation B2B Catalog & Linesheet Maker | ~57 review, $40/ay’dan başlayan fiyat; buyer order → Shopify Draft Order | Bizim hedef workflow’un doğrudan pazar kanıtı. |
| B2B Bulk Order / PO Upload | ~18 review, 4.9; SKU/Qty, CSV/XLSX/copy-paste | Buyer speed problemi gerçek; review’larda customer-service time saving açıkça görülüyor. |
| WSH Order Form & ReOrder | ~178 review, 4.9, Built for Shopify | Quick order/bulk order ayrı başına büyük ve olgun bir job. |
| Wholesale apps + Draft Orders filtresi | 250+ app bandı | Talep büyük; ama generic wholesale suite alanı kalabalık. Dar wedge şart. |



## 2.2 Shopify native B2B tehdidi / fırsatı

- Shopify B2B artık Basic, Grow, Advanced ve Plus planlarda kullanılabiliyor; companies, catalogs, net payment terms ve self-serve ordering gibi çekirdek özellikler geniş ölçüde native.
- Basic/Grow/Advanced: tüm B2B market’ler için toplam 3 active catalog limiti. Plus: unlimited catalog ve company/location’a doğrudan catalog assignment gibi daha ileri özellikler.
- Sonuç: “company + catalog + pricing” platformu olmak gereksiz risk. Native Shopify ile yarışmak yerine buyer-facing order capture katmanı olmalıyız.
- Ürün, native B2B kullanan merchant’a da kullanmayan merchant’a da değer vermeli. İlk sürüm buyer account/company kurulumu gerektirmemeli.

> [!NOTE]
> **Anti-commodity kuralı**
> Shopify’ın native yapabileceği “catalog tanımlama / price list / company” işini ana ürün yapma. Biz “buyer’ın 60 varyantı 90 saniyede siparişe çevirmesi” işini yapıyoruz.



## 2.3 Rakip haritası


| **Rakip** | **Gücü** | **Zayıflık / açıklık** | **Bizim yaklaşım** |
| --- | --- | --- | --- |
| EasyCatalog | PDF/flipbook/customization, geniş feature set | Customization scope’u ağır; negatif review’larda UX, save/rebuild, pricing/support şikayetleri görülüyor | PDF-first yarışma; ordering speed + reliable sync |
| ZINation | Catalog + integrated cart + Draft Order; $40+ ARPU | Daha ağır catalog studio; fiyat seviyesi yüksek | 10 dakikada publish; structured templates; daha sade |
| WSH Order Form | Quick order/reorder alanında güçlü review ve BFS | Catalog/brand/shareable sales surface wedge’i daha zayıf | Catalog discovery + quick order tek surface |
| B2B Bulk Order / PO Upload | SKU paste/CSV ordering çok hızlı | Görsel catalog/discovery deneyimi dar | Visual browse + variant matrix; P1’de paste/CSV |
| BSS / full suites | Quote, pricing, rules, customer groups | Feature bloat; ağır setup | No-login buyer link + Draft Order only |



# 3. ICP, Persona & Jobs-to-be-Done


| **Özellik** | **Primary ICP** |
| --- | --- |
| Business model | Wholesale / B2B + DTC hybrid Shopify merchant |
| Catalog size | 30–5.000 SKU/variant |
| Buyer count | 10–500 recurring retailers / dealers / resellers / sales reps |
| Order pattern | Repeat bulk orders, multi-variant, 10–200 line item bandı |
| Current workaround | PDF + order sheet, Excel/CSV, WhatsApp/email, phone orders, sales rep entry |
| Team | Founder/ops/customer service/sales team 1–20 kişi |
| Pain severity | Aynı ürün listesini paylaşma + siparişi yeniden yazma işi haftalık tekrarlanıyor |
| Best verticals | Apparel, accessories, home/decor, beauty, food/beverage wholesale, components/parts, stationery, cycling/sport goods |



## 3.1 Primary JTBD


> [!NOTE]
> **JTBD**
> “Bir buyer yeniden sipariş vermek istediğinde ona güncel ürünleri ve wholesale fiyatı tek linkte göstermek; buyer’ın varyant/adetleri hızlı seçmesini sağlamak; gelen siparişi tekrar elle girmeden Shopify Draft Order olarak almak istiyorum.”



## 3.2 Buyer JTBD

- SKU veya ürün adıyla hızlı bul.
- Renk/beden/varyantları tek tabloda gör; ürün sayfasına tek tek girme.
- Adetleri klavyeyle seri gir.
- Order summary’de yanlışları gör.
- PO number ve not ekle; tek submit ile siparişi satıcıya ilet.
- Hangi ürünün stokta olmadığını veya fiyatının değiştiğini submit anında öğren.

# 4. Positioning & Product Wedge


> [!NOTE]
> **Positioning**
> “Send one wholesale link. Buyers bulk-order variants in seconds. Draft Orders land in Shopify.”



| **Mesaj katmanı** | **Copy** |
| --- | --- |
| Headline | Turn your Shopify products into a fast wholesale ordering catalog. |
| Subline | Share one live link, let buyers enter variant quantities, and receive every submission as a Shopify Draft Order. |
| Proof / differentiation | No spreadsheets. No buyer account required. No rebuilding stale PDFs. |
| Trust layer | Live Shopify sync + submit-time revalidation prevents stale product/price surprises. |



## 4.1 Neden kazanabilir?

- Dar scope: full wholesale suite değil; tek job’u mükemmel yapar.
- Buyer-side UX wedge: variant matrix + bulk qty entry + sticky summary.
- No-login link: buyer onboarding friction’i yok.
- Draft Order outcome: merchant’ın Shopify workflow’unun içinde kalır.
- Reliability wedge: product/price/availability submit anında revalidate edilir; stale catalog sessizce yanlış order üretmez.
- Structured UI: Canva/editor complexity’sine girmeden polished görünür.

# 5. V1 Scope — Build Exactly This


| **P0 — Ship** | **P1 — After traction** | **Not in V1** |
| --- | --- | --- |
| Embedded merchant adminCatalog create/edit/publishProduct/collection selectionLive product/variant syncPublic no-login catalog linkSearch/filterVariant matrix + qty entryCatalog-wide % wholesale discountOrder summaryBuyer email + business + PO + noteSubmit → Draft OrderSubmit-time revalidationOrder submission history (non-PII)Billing + quotasBasic analytics<br><br><br><br><br><br><br><br><br><br><br><br><br><br> | Password-protected catalogsCSV/XLSX SKU paste/uploadPDF/linesheet exportReorder from prior orderPer-product MOQ/step qtyCatalog analyticsCustom domain / branded linkNative B2B catalog price contextSales rep mode<br><br><br><br><br><br><br><br> | Canva/freeform editor50+ templatesCustom CSSAI designFull quote negotiationAR/AP/invoicingOwn checkout/payment flowCustomer-specific pricing engineERP/3PL integrationsMulti-currency engineComplex tax engineTheme app extension dependencyMobile app<br><br><br><br><br><br><br><br><br><br><br><br> |



> [!NOTE]
> **Scope lock**
> V1 başarı testi: merchant 10 dakikada link yayınlayabiliyor mu ve buyer 1–2 dakikada 20+ line item siparişini Draft Order’a çevirebiliyor mu? Bunun dışındaki her feature ertelenebilir.



# 6. End-to-End User Flows


## 6.1 Merchant onboarding


> [!NOTE]
> Install app
> → OAuth / scopes
> → Initial product sync
> → “Create your first catalog”
> → Select collections/products
> → Choose pricing: Shopify price OR X% wholesale discount
> → Add logo + accent color
> → Publish
> → Copy public link
> → Run test order
> → Draft Order appears in Shopify



## 6.2 Buyer order flow


> [!NOTE]
> Open public catalog link
> → Search / collection filter
> → Product row / card
> → Variant matrix (e.g. Black S/M/L)
> → Enter quantities
> → Sticky “Order summary (24 items)”
> → Review
> → Business name + email + optional PO + note
> → Submit
> → Server revalidates selected variants/prices/availability
> ├─ changed → buyer reviews updated lines
> └─ valid → Shopify Draft Order created
> → Success screen + reference number



## 6.3 Stale-data safety flow

- Public catalog snapshot hızlı render için DB’den gelir.
- Buyer submit ettiğinde sadece seçilmiş variant ID’leri Shopify’dan tekrar çekilir.
- Deleted/unavailable variant varsa submission otomatik ilerlemez; affected lines döner.
- Shopify price değiştiyse wholesale display price yeniden hesaplanır; buyer’a changed-lines response gösterilir.
- Buyer “Review updated order” yaptıktan sonra yeni idempotency key ile tekrar submit eder.
- Draft Order yaratımı idempotent olmalı; double-click iki draft yaratmamalı.

# 7. Functional Requirements & Acceptance Criteria


| **ID** | **Requirement** | **Definition** | **Acceptance** |
| --- | --- | --- | --- |
| CAT-01 | Catalog create | Merchant selected collections/products ile catalog oluşturabilir. | Catalog DRAFT olarak oluşur; selected sources persisted. |
| CAT-02 | Catalog publish | Merchant published catalog için opaque public URL alır. | Unpublished token 404; published token 200. |
| CAT-03 | Live sync | Product create/update/delete webhook’ları snapshot’ı günceller. | Update 60 sn içinde public catalog’a yansır veya manual resync ile anında. |
| CAT-04 | Deterministic pricing | SHOPIFY_PRICE veya PERCENT_DISCOUNT mode. | Aynı Shopify price + discount config aynı display/draft price üretir. |
| BUY-01 | Search/filter | Buyer title, SKU, vendor/collection ile filtreleyebilir. | 5000 variant dataset üzerinde client/search response p95 < 250 ms after load. |
| BUY-02 | Variant matrix | Buyer bir ürünün varyantlarına toplu qty girebilir. | Qty yalnız integer >=0; invalid entry inline error. |
| BUY-03 | Summary | Selected lines sticky summary’de görünür. | Line count, unit price, qty, subtotal doğru. |
| BUY-04 | Submit form | Business name + email required; PO/note optional. | Invalid email submit olmaz. |
| ORD-01 | Revalidation | Submit öncesi selected variants Shopify’dan re-fetch edilir. | Deleted/unavailable/price-changed line silent pass etmez. |
| ORD-02 | Draft Order | Valid submission Shopify Draft Order yaratır. | Variant IDs/qty/discount/PO/email/tag doğru; userErrors surfaced. |
| ORD-03 | Idempotency | Same submit retry duplicate draft yaratmaz. | Same catalog + idempotency key → same result/draftOrderId. |
| PRI-01 | PII minimization | Successful submission sonrası raw buyer email app DB’de saklanmaz. | DB record aggregate/non-PII only; Shopify Draft Order source of truth. |
| BIL-01 | Quota | Plan limit aşıldığında new catalog/order submission sınırı anlaşılır gösterilir. | No surprise overage; hard cap + upgrade CTA. |
| OPS-01 | Uninstall | Uninstall shop’u deactivates and stops jobs. | Tokens/sessions cleaned per policy; public links no longer serve. |



# 8. UX / Screen Specification


| **Screen** | **Amaç** | **Ana bileşenler** | **Primary CTA** |
| --- | --- | --- | --- |
| Dashboard | Activation + value | Catalog count, submissions, Draft Orders, sync health, latest activity | Create catalog |
| Catalog list | Manage | Status, products, last sync, orders, public link | Open / Publish |
| Create wizard 1 | Select inventory | Collections, products, search, selected count | Continue |
| Create wizard 2 | Pricing | Shopify price / % discount; preview 3 sample products | Continue |
| Create wizard 3 | Brand/publish | Catalog name, logo, accent, show SKU/inventory toggles | Publish catalog |
| Catalog detail | Operate | Link, preview, sync status, settings, submissions | Copy buyer link |
| Public catalog | Buyer shop | Brand header, search, filters, product/variant matrix, sticky summary | Review order |
| Buyer review | Validate | Selected lines, totals, contact/PO/note | Submit order |
| Success | Confidence | Reference, submitted time, “seller will confirm” | Done |
| Submissions | Merchant history | CreatedAt, catalog, item count, subtotal, Draft Order deep link | Open in Shopify |



> [!NOTE]
> **UX principle**
> Catalog builder merchant’a “design tool” gibi hissettirmemeli. 3 adımda publish. Buyer surface ise spreadsheet hızını storefront polish’iyle birleştirmeli.



# 9. Pricing, Packaging & Monetization


| **Plan** | **Price** | **Limits** | **Who** |
| --- | --- | --- | --- |
| Starter | $14.99/mo | 1 live catalog • 500 variants • 50 buyer submissions/mo | Small wholesale / first digital catalog |
| Growth | $29.99/mo | 5 live catalogs • 5,000 variants • 250 submissions/mo | Active B2B merchant |
| Scale | $49.99/mo | 20 live catalogs • 25,000 variants • 1,000 submissions/mo • priority support | High-volume wholesale team |


- 7-day free trial recommended; no permanent Free plan in initial hypothesis. B2B value is high and support cost is real.
- No usage-based overage in V1. Limit hit → clear upgrade CTA or wait until next billing period.
- Grandfather early customers for first 6–12 months if pricing increases.
- Pricing is a hypothesis; first 10 paid merchants determine whether Starter should move to $19 and Growth to $39.

## 9.1 $1k MRR math


| **Mix** | **MRR** |
| --- | --- |
| 10 × Starter | $149.90 |
| 20 × Growth | $599.80 |
| 5 × Scale | $249.95 |
| TOTAL — 35 paid merchants | $999.65 |



# 10. Technical Architecture


> [!NOTE]
> **Stack recommendation**
> Shopify React Router app + Node/TypeScript + Prisma + PostgreSQL + Railway (Web + Worker) + GraphQL Admin API 2026-07. Reuse SafeMerge deployment/billing/session patterns where appropriate; do not reuse product-specific complexity.



> [!NOTE]
> Shopify Admin (merchant)
> │ Embedded app
> ▼
> Web / React Router ───────────── PostgreSQL
> │ admin routes                   │ catalogs / snapshots / sync
> │ public catalog API             │ non-PII submissions
> │                                 │ idempotency / billing
> ├── Shopify GraphQL Admin API ◄──┘
> │      products / variants / draftOrderCreate
> │
> ├── Public buyer page: /c/{opaqueToken}
> │      read catalog snapshot
> │      submit selected lines
> │
> └── Worker
> webhook processing / resync / retention



## 10.1 Recommended Shopify scopes


| **Scope** | **Why** | **V1** |
| --- | --- | --- |
| read_products | Product/variant title, SKU, images, prices | Required |
| read_inventory | Availability/inventory signal if displayed | Recommended |
| write_draft_orders | Create Draft Order from buyer submission | Required |
| read_draft_orders | Display submission outcome / deep-link state if needed | Recommended |
| write_app_proxy | Only if later using merchant-domain /apps/... URL | Not required in initial standalone public URL |
| read_customers / write_customers | Customer mapping | Avoid in V1 |



## 10.2 Webhooks


| **Topic** | **Behavior** |
| --- | --- |
| products/create | Fetch + upsert product/variants; include in matching collection-source catalogs. |
| products/update | Refresh normalized snapshots; increment catalog dataVersion if affected. |
| products/delete | Tombstone/remove from public catalog; buyer stale submission will revalidate fail. |
| app/uninstalled | Mark shop uninstalled, stop jobs, disable public links, retention cleanup. |
| customers/data_request / customers/redact / shop/redact | Mandatory privacy webhooks; implement even with minimized PII. |



# 11. Data Model


> [!NOTE]
> Shop
> - id, shopDomain, plan, installedAt, uninstalledAt
> Catalog
> - id, shopId, name, publicToken, status[DRAFT|PUBLISHED|ARCHIVED]
> - priceMode[SHOPIFY_PRICE|PERCENT_DISCOUNT], discountPercent
> - logoUrl, accentColor, showSku, showInventory
> - dataVersion, publishedAt, createdAt, updatedAt
> CatalogSource
> - id, catalogId, type[COLLECTION|PRODUCT], shopifyGid
> ProductSnapshot
> - shopId, shopifyProductId, title, vendor, handle, imageUrl, status
> - sourceUpdatedAt, syncedAt
> VariantSnapshot
> - shopId, shopifyVariantId, shopifyProductId
> - title, sku, barcode, shopifyPrice, inventoryQuantity, availableForSale
> - selectedOptionsJson, imageUrl, sourceUpdatedAt, syncedAt
> CatalogItemOverride (P1-capable; keep minimal)
> - catalogId, shopifyProductId, enabled, position
> OrderSubmission
> - id, shopId, catalogId, draftOrderId, idempotencyKeyHash
> - itemCount, subtotalAmount, currency, createdAt
> - NO raw email / address after success
> SyncRun
> - id, shopId, type, status, statsJson, startedAt, finishedAt
> WebhookReceipt
> - webhookId unique, topic, processedAt



> [!NOTE]
> **Data principle**
> Shopify is source of truth for product identity and base price. Local snapshots are read-optimized cache. Final order creation must revalidate selected variants against Shopify.



# 12. Pricing Logic (V1)


| **Mode** | **Display** | **Draft Order** |
| --- | --- | --- |
| SHOPIFY_PRICE | latest Shopify variant price | variantId + qty; no custom discount |
| PERCENT_DISCOUNT | shopifyPrice × (1 - discount%) | variantId + qty + line-item appliedDiscount percentage |


- Discount percent catalog-level only in V1 (0–90). No per-buyer pricing engine.
- Rounding uses Shopify Money semantics; currency is shop currency in V1.
- Submit-time revalidation recomputes display price from latest Shopify base price + same discount config.
- If calculated price changed from buyer’s page snapshot, return change review instead of silently creating a different-priced draft.

# 13. Public API / Route Contract


> [!NOTE]
> GET /c/:publicToken
> → public buyer page
> GET /api/public/catalog/:publicToken
> → { catalog, collections, products[], dataVersion }
> POST /api/public/catalog/:publicToken/validate
> body: { dataVersion, lines:[{variantId, qty}] }
> → VALID | CHANGED | INVALID
> POST /api/public/catalog/:publicToken/submit
> headers: Idempotency-Key
> body: { dataVersion, lines[], buyer:{businessName,email,poNumber?,note?} }
> → 201 { submissionId, draftOrderId, reference }
> → 409 { code:"CATALOG_CHANGED", changedLines[] }
> → 422 { code:"INVALID_LINES", lines[] }
> Admin embedded routes
> /app
> /app/catalogs
> /app/catalogs/new
> /app/catalogs/:id
> /app/submissions
> /app/settings/billing



# 14. Reliability, Security & Privacy


| **Risk** | **Control** |
| --- | --- |
| Duplicate Draft Orders | Idempotency-Key unique per catalog; DB transaction + unique index; return prior result on retry. |
| Stale product/price | Submit-time GraphQL revalidation of only selected variants. |
| Deleted/out-of-stock line | Block/flag line; never silently substitute variant. |
| Public token enumeration | 128-bit+ cryptographically random opaque token; no sequential IDs in public URL. |
| Abuse/spam | Rate limit per publicToken/IP; hidden honeypot; optional CAPTCHA only if abuse appears. |
| Buyer PII | Raw email processed synchronously to Shopify; successful submission DB stores no raw email/address. Logs redact email/token. |
| Webhook replay | Shopify webhook verification + webhookId idempotency. |
| Uninstall exposure | Immediately disable public catalog access after app/uninstalled. |
| Secrets | Railway/GitHub secrets only; never logs; least scopes. |



# 15. Analytics & Product Metrics


| **Layer** | **Metric** | **Healthy early signal** |
| --- | --- | --- |
| Acquisition | App install → onboarding start | >70% |
| Activation | Install → first published catalog | >40% |
| Activation | Published catalog → test/real submission | >30% |
| Buyer | Catalog view → order summary started | >15% depending traffic quality |
| Buyer | Summary started → submitted | >40% |
| Reliability | Submit → Draft Order success | >98% excluding merchant configuration errors |
| Retention | Merchant with ≥2 submissions in 30d | >50% of activated |
| Monetization | Trial → paid | >15% initial target |
| Support | Same issue from 3 merchants | Roadmap trigger |



> [!NOTE]
> **North Star event**
> draft_order_created_from_buyer_submission



# 16. Onboarding & Empty-State Copy


| **Context** | **Copy** |
| --- | --- |
| Dashboard empty | Create your first wholesale catalog in under 10 minutes. |
| Catalog wizard intro | Choose what buyers can order. Safe Catalog stays synced with Shopify. |
| Pricing | Use your Shopify prices or apply one wholesale discount to this catalog. |
| Publish success | Your buyer link is live. Send it by email, WhatsApp, or to your sales reps. |
| No submissions | Test the buyer experience yourself — your first submission will appear as a Draft Order. |
| Changed at submit | Some products changed since this catalog was opened. Review the updated lines before submitting. |



# 17. Test Plan — Must Pass Before Launch


| **Area** | **Tests** |
| --- | --- |
| Catalog sync | create/update/delete; collection membership; variant add/remove; image/price/SKU changes; 5k variants |
| Pricing | 0%, 10%, 33.3%, 90%; decimal rounding; zero price; price update mid-session |
| Buyer UX | search SKU/title; 0 qty; large qty; 100+ selected lines; mobile/tablet; refresh preserves cart locally |
| Revalidation | deleted variant; unavailable variant; changed price; changed discount config; catalog unpublished during session |
| Draft Order | correct IDs/qty; applied discount; buyer email; business/PO/note; userErrors; 499 line Shopify limit guard |
| Idempotency | double click; network timeout after Shopify success; same key retry; different key intentional resubmit |
| Auth/lifecycle | install, reinstall, uninstall, expired session, worker only active shops |
| Privacy | logs redact email/public token; shop redact/data request; raw buyer email absent in successful DB record |
| Billing | trial, upgrade/downgrade, hard cap, plan reset, no overage |
| Performance | public catalog initial payload/page; pagination/lazy load; API p95; DB index checks |



# 18. 10-Day Build Plan


| **Day** | **Deliverable** | **Exit criterion** |
| --- | --- | --- |
| 1 | Shopify app foundation, Prisma, sessions, billing skeleton, Shop lifecycle | Install/reinstall/uninstall clean |
| 2 | Product/variant initial sync + webhooks + normalized snapshots | Catalog data cache reliable |
| 3 | Merchant catalog create wizard: sources + price mode + branding | DRAFT can be created/edited |
| 4 | Publish + public token + buyer catalog rendering/search/filter | Public link usable |
| 5 | Variant matrix + cart/summary + buyer form | Buyer can build 20-line order fast |
| 6 | Submit revalidation + draftOrderCreate + idempotency | No stale/duplicate draft order |
| 7 | Submissions/history, deep link to Shopify, sync health | Merchant operations complete |
| 8 | Billing limits + onboarding + analytics events | Commercial loop complete |
| 9 | Security/privacy/retention + full tests + perf hardening | Launch blockers closed |
| 10 | Listing assets/copy/screencast/testing instructions + self review | Ready to submit |



# 19. Distribution & Shopify App Store Strategy

- Search-intent wedge: “wholesale catalog”, “B2B order form”, “quick order”, “linesheet”, “bulk order”, “draft order”.
- Listing screenshots buyer outcome göstermeli: 1) share live catalog, 2) bulk variant ordering, 3) Draft Order in Shopify, 4) live sync/revalidation.
- Hero message feature değil outcome: “Let wholesale buyers order faster from one live catalog link.”
- İlk 5–10 genuine review kritik. Incentive yok; active merchant’a başarı event’inden sonra native review ask.
- Outbound gerektirmeyen primary distribution App Store. Secondary: public catalog footer’da merchant-controlled “Powered by …” link P1 olarak değerlendirilebilir (spammy olmamalı).

## 19.1 Listing draft


| **Field** | **Draft** |
| --- | --- |
| App name candidate | CatalogFlow: B2B Order Catalog |
| Subtitle | Live wholesale catalog & fast bulk ordering |
| Intro | Turn Shopify products into a live wholesale catalog where buyers enter variant quantities and submit orders directly to Shopify Draft Orders. |
| Feature 1 | Share one live wholesale catalog link |
| Feature 2 | Let buyers bulk-order variants from one screen |
| Feature 3 | Create Shopify Draft Orders from every submission |
| Feature 4 | Keep products and prices synced with Shopify |
| Feature 5 | Prevent stale orders with submit-time revalidation |



# 20. Risk Register & Kill Criteria


| **Risk** | **Severity** | **Mitigation / decision** |
| --- | --- | --- |
| Shopify native B2B keeps expanding | High | Do not own generic catalogs/pricing. Stay buyer-order UX layer and integrate native data later. |
| Category crowded | High | Avoid full-suite positioning; optimize exact quick-order + catalog intent. |
| Customization requests explode | High | Structured templates only; 3 merchants asking same need before adding. |
| Buyer portal traffic low | Medium | Activation instrumentation; merchant needs to actually share link. |
| Wholesale pricing complexity | High | V1 only Shopify price or catalog-wide %. No customer-specific pricing engine. |
| PII/compliance burden | Medium | No raw buyer PII persistence after success; Shopify Draft Order source of truth. |
| Large catalog performance | Medium | Snapshot cache, pagination/lazy render, indexes, submit only selected IDs. |



## 20.1 Decision thresholds


| **Time** | **Kill / passive** | **Continue** | **Double down** |
| --- | --- | --- | --- |
| 30 days | <3 activated merchants or zero real buyer submissions | 3–10 paid/active + repeat submissions | 10+ paid and clear repeat ordering |
| 60 days | <3 paid + low usage | 5–15 paid; keep iterating | 15–25+ paid / $400+ MRR |
| 90 days | <5 paid → maintenance mode | 10–25 paid → viable small app | 30–40+ paid / ~$750–$1.2k MRR → winner candidate |



# 21. Roadmap After Traction


| **Priority** | **Feature** | **Trigger** |
| --- | --- | --- |
| P1 | CSV/XLSX upload + paste SKU/qty | 3+ merchants / buyer feedback asks for repeat PO speed |
| P1 | Password-protected catalogs | 3+ merchants need private prices without account setup |
| P1 | Reorder from prior submission/order | Repeat-order cohort significant |
| P1 | PDF / linesheet export | Merchant explicitly needs trade-show/offline workflow |
| P1 | MOQ / increments | 3+ merchants blocked by order quantity rules |
| P2 | Native Shopify B2B catalog/company pricing context | Paid Plus/native B2B cohort grows |
| P2 | Sales rep mode | Sales teams use public link internally |
| P2 | Custom domain / vanity URL | Brand-sensitive merchants convert on demand |
| Avoid | Full quote negotiation / payment / ERP | Only if product becomes different company direction |



# 22. Antigravity / Coding Agent Master Build Brief


> [!NOTE]
> Build a production-ready public Shopify app whose single job is:
> Shopify products → live wholesale catalog → buyer bulk variant/qty order → Shopify Draft Order.
> NON-NEGOTIABLES
> - Shopify financial/catalog product data remains source of truth.
> - No Canva/freeform editor.
> - No full wholesale suite.
> - No customer-specific pricing engine in V1.
> - Public buyer link requires no account.
> - V1 price modes: Shopify price OR catalog-wide percentage discount.
> - Submit-time revalidate selected variants/prices/availability against Shopify.
> - Idempotent Draft Order creation.
> - Successful submissions do not persist raw buyer email/address in our DB.
> - GraphQL Admin API 2026-07 only; no REST.
> - Production-grade install/reinstall/uninstall lifecycle and mandatory privacy webhooks.
> - Tests must cover sync, pricing, stale data, idempotency, billing, privacy, lifecycle.
> PRIMARY USER FLOW
> Merchant creates catalog in 3 steps, publishes link, buyer enters variant quantities, submits business/email/PO/note, app validates current Shopify data, then creates Draft Order and shows success.
> Do not expand scope without an explicit product decision.



# 23. Final Product Verdict


> [!NOTE]
> **Final verdict: BUILD — 8.2/10**
> Bu fikir “catalog maker” olarak ortalama; “buyer ordering portal disguised as a live catalog” olarak güçlü. Talep kanıtlı, B2B willingness-to-pay yüksek, Shopify Draft Order outcome net ve SafeMerge’den öğrendiğimiz lifecycle/compliance/distribution kasını yeniden kullanabiliriz. En büyük risk rekabet değil scope creep ve Shopify native B2B ile yanlış yerde yarışmak.



| **Score** | **/10** | **Reason** |
| --- | --- | --- |
| Pain / urgency | 8.4 | Repeat wholesale ordering operasyonel ve haftalık/aylık tekrarlanan iş. |
| Willingness to pay | 8.5 | $19–$40+ bandında rakipler yıllardır yaşayabiliyor. |
| Distribution fit | 8.0 | Shopify App Store intent var; outbound zorunlu değil. |
| Factory fit | 8.3 | 7–10 gün P0 mümkün; backend/integration ağırlığı güçlü taraf. |
| Competition | 6.8 | Kategori kalabalık; positioning dar olmazsa boğulur. |
| Platform risk | 7.0 | Shopify native B2B genişliyor; buyer UX layer ile korunmalı. |
| Overall | 8.2 | BUILD |



> [!NOTE]
> **Tek odak**
> B2B Catalog bundan sonra “güzel katalog üret” projesi değil. “Buyer siparişini Shopify’a en kısa ve güvenilir yoldan sok” projesidir.



# Sources & Market Evidence

**1. Shopify Help — B2B features by plan — **https://help.shopify.com/en/manual/b2b/getting-started/plan-features

**2. Shopify Help — Catalogs and pricing in B2B — **https://help.shopify.com/en/manual/b2b/catalogs

**3. Shopify Dev — Manage B2B catalogs — **https://shopify.dev/docs/apps/build/b2b/manage-catalogs

**4. Shopify Dev — draftOrderCreate GraphQL Admin API — **https://shopify.dev/docs/api/admin-graphql/latest/mutations/draftordercreate

**5. Shopify Dev — DraftOrderLineItemInput — **https://shopify.dev/docs/api/admin-graphql/latest/input-objects/draftorderlineiteminput

**6. Shopify Dev — productVariants query — **https://shopify.dev/docs/api/admin-graphql/latest/queries/productVariants

**7. Shopify Dev — App proxies — **https://shopify.dev/docs/apps/build/online-store/app-proxies/index

**8. Shopify App Store — Catalog Maker by EasyCatalog — **https://apps.shopify.com/easy-catalogs

**9. Shopify App Store — EasyCatalog reviews — **https://apps.shopify.com/easy-catalogs/reviews

**10. Shopify App Store — B2B Catalog & Linesheet Maker (ZINation) — **https://apps.shopify.com/zine-builder

**11. Shopify App Store — B2B Bulk Order / PO Upload reviews — **https://apps.shopify.com/swift-b2b-cart-csv-upload/reviews

**12. Shopify App Store — WSH Order Form & ReOrder — **https://apps.shopify.com/single-page-order-form

**13. Shopify App Store — BSS B2B Order / Request a Quote — **https://apps.shopify.com/b2b-customer-portal-quick-order

**14. Shopify App Store — Wholesale apps with Draft Orders — **https://apps.shopify.com/categories/finding-products-sourcing-options-wholesale/all?feature_handles%5B%5D=cf.wholesale.order_management.draft_orders

*Research snapshot: 07 Sep 2026. Review counts/pricing can change. Product decisions above deliberately avoid relying on exact competitor counts as a moat.*
