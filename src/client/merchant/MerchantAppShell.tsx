import React, { useState, useEffect, useCallback } from 'react';
import { authenticatedFetch } from './appBridgeAuth.js';
import './merchant.css';

interface ShopInfo {
  id: string;
  shopDomain: string;
  plan: string;
  initialSyncAt: string | null;
  installed: boolean;
}

interface QuotaInfo {
  planTier: string;
  limits: {
    name: string;
    price: number;
    maxLiveCatalogs: number;
    maxVariants: number;
    monthlySubmissionsLimit: number;
  };
  usage: {
    liveCatalogsCount: number;
    monthlySubmissionsCount: number;
  };
  allowed: {
    canPublishCatalog: boolean;
    canAcceptSubmission: boolean;
  };
}

interface PlanFeatureDetails {
  id: string;
  name: string;
  price: number;
  interval: string;
  maxLiveCatalogs: number;
  maxVariants: number;
  monthlySubmissionsLimit: number;
  features: string[];
}

interface BillingData {
  currentPlan: string;
  planDetails: PlanFeatureDetails;
  limits: {
    name: string;
    price: number;
    maxLiveCatalogs: number;
    maxVariants: number;
    monthlySubmissionsLimit: number;
  };
  usage: {
    liveCatalogsCount: number;
    monthlySubmissionsCount: number;
    maxVariantsInPublishedCatalogs: number;
    billingCycleAnchor: string;
    nextBillingCycleAt: string;
  };
  allowed: {
    canPublishCatalog: boolean;
    canAcceptSubmission: boolean;
  };
  availablePlans: PlanFeatureDetails[];
}

interface AnalyticsData {
  periodDays: number;
  counts: {
    catalogViews: number;
    orderSummariesStarted: number;
    ordersSubmitted: number;
    draftOrdersCreated: number;
  };
  conversionRates: {
    viewToSummaryPct: number;
    summaryToSubmitPct: number;
    submitToDraftPct: number;
    overallConversionPct: number;
  };
}

interface CatalogSummary {
  id: string;
  name: string;
  publicToken: string;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  priceMode: 'SHOPIFY_PRICE' | 'PERCENT_DISCOUNT';
  discountPercent: number | null;
  accentColor: string;
  showSku: boolean;
  showInventory: boolean;
  createdAt: string;
  updatedAt: string;
  productCount?: number;
  variantCount?: number;
  sources: Array<{ type: 'COLLECTION' | 'PRODUCT'; shopifyGid: string }>;
}

interface OrderSubmissionItem {
  id: string;
  catalogId: string;
  catalogName: string;
  catalogPublicToken: string;
  status?: string;
  lastError?: string | null;
  draftOrderId: string;
  draftOrderName: string | null;
  draftOrderUrl: string;
  itemCount: number;
  lineCount: number;
  subtotalAmount: number;
  formattedSubtotal: string;
  currency: string;
  createdAt: string;
}

interface SyncHealthData {
  shop: {
    shopDomain: string;
    plan: string;
    currency: string;
    monthlySubmissionsCount: number;
    initialSyncAt: string | null;
    installedAt: string | null;
  };
  catalogs: {
    total: number;
    published: number;
    draft: number;
  };
  inventory: {
    productsCount: number;
    variantsCount: number;
    collectionsCount: number;
  };
  submissions: {
    total: number;
    monthly: number;
  };
  sync: {
    status: string;
    lastSyncAt: string | null;
    lastSyncStats: any;
  };
  jobs?: {
    pending: number;
    failed: number;
    lastFailedAt: string | null;
    lastError: string | null;
  };
}

type TabType = 'overview' | 'catalogs' | 'submissions' | 'sync' | 'billing';

export const MerchantAppShell: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabType>('overview');
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [shop, setShop] = useState<ShopInfo | null>(null);
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  const [billing, setBilling] = useState<BillingData | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [catalogs, setCatalogs] = useState<CatalogSummary[]>([]);
  const [submissions, setSubmissions] = useState<OrderSubmissionItem[]>([]);
  const [submissionsTotal, setSubmissionsTotal] = useState<number>(0);
  const [submissionsPage, setSubmissionsPage] = useState<number>(1);
  const [submissionStatusFilter, setSubmissionStatusFilter] = useState<string>('ALL');
  const [syncHealth, setSyncHealth] = useState<SyncHealthData | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [switchingPlan, setSwitchingPlan] = useState<boolean>(false);
  const [reconcilingId, setReconcilingId] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [billingUnavailable, setBillingUnavailable] = useState<boolean>(false);
  const [quotaError, setQuotaError] = useState<boolean>(false);
  const [analyticsError, setAnalyticsError] = useState<boolean>(false);

  // ── Catalog creation wizard state ─────────────────────────────────────────
  const [showCreateModal, setShowCreateModal] = useState<boolean>(false);
  const [wizardStep, setWizardStep] = useState<1 | 2 | 3>(1);
  const [creatingCatalog, setCreatingCatalog] = useState<boolean>(false);

  // Step 1 — source selection
  interface ResourceItem { id: string; title: string; imageUrl?: string | null; detail?: string | null }
  const [searchTab, setSearchTab] = useState<'COLLECTION' | 'PRODUCT'>('COLLECTION');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchResults, setSearchResults] = useState<ResourceItem[]>([]);
  const [searchLoading, setSearchLoading] = useState<boolean>(false);
  const [selectedSources, setSelectedSources] = useState<Array<{ type: 'COLLECTION' | 'PRODUCT'; id: string; title: string }>>([]);

  // Step 2 — pricing
  const [newPriceMode, setNewPriceMode] = useState<'SHOPIFY_PRICE' | 'PERCENT_DISCOUNT'>('SHOPIFY_PRICE');
  const [newDiscount, setNewDiscount] = useState<number>(10);

  // Step 3 — details
  const [newCatalogName, setNewCatalogName] = useState<string>('');
  const [newAccentColor, setNewAccentColor] = useState<string>('#108043');
  const [newPublish, setNewPublish] = useState<boolean>(false);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };


  const loadData = useCallback(async () => {
    try {
      // Bootstrap & Shop — critical; fail loudly if this fails
      const bootstrapRes = await authenticatedFetch('/api/admin/bootstrap', { method: 'POST' });
      if (!bootstrapRes.ok) throw new Error('Authentication failed');
      const bootstrapData = await bootstrapRes.json();
      setShop(bootstrapData.shop);

      // Secondary fetches — failures are non-fatal: show degraded states per widget
      const [quotaRes, billingRes, analyticsRes] = await Promise.all([
        authenticatedFetch('/api/admin/quota'),
        authenticatedFetch('/api/admin/billing'),
        authenticatedFetch('/api/admin/analytics'),
      ]);

      if (quotaRes.ok) {
        setQuota(await quotaRes.json());
        setQuotaError(false);
      } else {
        setQuotaError(true);
      }
      if (billingRes.ok) {
        const billingData = await billingRes.json();
        setBilling(billingData);
        // Detect if billing plan-switching is not yet wired in production
        setBillingUnavailable(
          billingData.billingStatus === 'SHOPIFY_APP_PRICING_PENDING_M10' ||
          billingData.entitlementSource === 'LOCAL_MIRROR_PENDING_SHOPIFY'
        );
        setAnalyticsError(false);
      } else {
        setBillingUnavailable(true);
      }
      if (analyticsRes.ok) {
        setAnalytics(await analyticsRes.json());
        setAnalyticsError(false);
      } else {
        setAnalyticsError(true);
      }

      // Catalogs
      const catRes = await authenticatedFetch('/api/admin/catalogs');
      if (catRes.ok) {
        const catData = await catRes.json();
        setCatalogs(catData.catalogs || []);
      }

      // Submissions
      const statusParam = submissionStatusFilter ? `&status=${submissionStatusFilter}` : '';
      const subRes = await authenticatedFetch(`/api/admin/submissions?page=${submissionsPage}&pageSize=10${statusParam}`);
      if (subRes.ok) {
        const subData = await subRes.json();
        setSubmissions(subData.submissions || []);
        setSubmissionsTotal(subData.totalCount || 0);
      }

      // Sync Health
      const syncRes = await authenticatedFetch('/api/admin/sync/health');
      if (syncRes.ok) {
        setSyncHealth(await syncRes.json());
      }
    } catch (err: any) {
      setError(err.message || 'Failed to initialize embedded portal');
    } finally {
      setLoading(false);
    }
  }, [authenticatedFetch, submissionsPage, submissionStatusFilter]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handlePublishToggle = async (cat: CatalogSummary) => {
    const endpoint = cat.status === 'PUBLISHED' ? 'unpublish' : 'publish';
    try {
      const res = await authenticatedFetch(`/api/admin/catalogs/${cat.id}/${endpoint}`, {
        method: 'POST',
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || 'Failed to toggle status');
      }
      showToast(`Catalog ${cat.status === 'PUBLISHED' ? 'unpublished' : 'published'} successfully!`);
      loadData();
    } catch (err: any) {
      showToast(`Error: ${err.message}`);
    }
  };

  const handleCopyLink = (publicToken: string) => {
    const buyerUrl = `${window.location.origin}/c/${publicToken}`;
    navigator.clipboard.writeText(buyerUrl);
    showToast('Buyer catalog link copied to clipboard!');
  };

  const handleManualSync = async () => {
    setSyncing(true);
    try {
      const res = await authenticatedFetch('/api/admin/sync/trigger', { method: 'POST' });
      if (!res.ok) throw new Error('Failed to start sync');
      showToast('Catalog sync initiated. Waiting for completion...');

      // Poll real sync status instead of using a fake timer.
      // Backend returns sync.status from /api/admin/sync/health.
      const MAX_POLLS = 12; // ~12 seconds max wait
      const POLL_INTERVAL = 1000;
      for (let i = 0; i < MAX_POLLS; i++) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL));
        try {
          const healthRes = await authenticatedFetch('/api/admin/sync/health');
          if (healthRes.ok) {
            const health = await healthRes.json();
            setSyncHealth(health);
            if (health?.sync?.status !== 'IN_PROGRESS') {
              // Sync completed (or not running) — reload full data
              await loadData();
              showToast('Sync complete. Data refreshed.');
              return;
            }
          }
        } catch {
          // ignore transient poll errors; keep polling
        }
      }
      // Timed out polling — still reload data to pick up partial results
      await loadData();
      showToast('Sync triggered. Data may still be updating.');
    } catch (err: any) {
      showToast(`Sync trigger failed: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  };

  const handlePlanChange = async (targetPlan: string) => {
    if (billingUnavailable) {
      showToast('Plan switching is managed through Shopify App Pricing. Please use your Shopify Admin billing settings.');
      return;
    }
    setSwitchingPlan(true);
    try {
      const res = await authenticatedFetch('/api/admin/billing/change-plan', {
        method: 'POST',
        body: JSON.stringify({ plan: targetPlan }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to update plan');
      }
      showToast(`Plan successfully updated to ${targetPlan}!`);
      loadData();
    } catch (err: any) {
      showToast(`Billing error: ${err.message}`);
    } finally {
      setSwitchingPlan(false);
    }
  };

  const handleReconcileSubmission = async (submissionId: string) => {
    setReconcilingId(submissionId);
    try {
      const res = await authenticatedFetch(`/api/admin/submissions/${submissionId}/reconcile`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Reconciliation request failed');
      }
      if (data.reconciled) {
        showToast(`Order confirmed! Shopify Draft Order: ${data.draftOrderName || data.draftOrderId}`);
      } else {
        showToast(data.message || 'Draft order not yet confirmed in Shopify. Please retry shortly.');
      }
      loadData();
    } catch (err: any) {
      showToast(`Reconciliation error: ${err.message}`);
    } finally {
      setReconcilingId(null);
    }
  };

  // ── Wizard helpers ─────────────────────────────────────────────────────────
  const openCreateWizard = () => {
    setWizardStep(1);
    setSearchTab('COLLECTION');
    setSearchQuery('');
    setSearchResults([]);
    setSelectedSources([]);
    setNewPriceMode('SHOPIFY_PRICE');
    setNewDiscount(10);
    setNewCatalogName('');
    setNewAccentColor('#108043');
    setNewPublish(false);
    setShowCreateModal(true);
  };

  const runSearch = useCallback(async (tab: 'COLLECTION' | 'PRODUCT', q: string) => {
    setSearchLoading(true);
    setSearchResults([]);
    setSearchError(null);
    try {
      const endpoint = tab === 'COLLECTION'
        ? `/api/admin/collections/search?q=${encodeURIComponent(q)}&limit=20`
        : `/api/admin/products/search?q=${encodeURIComponent(q)}&limit=20`;
      const res = await authenticatedFetch(endpoint);
      if (!res.ok) {
        setSearchError(`Search failed (${res.status}). Please try again.`);
        return;
      }
      const data = await res.json();
      if (tab === 'COLLECTION') {
        setSearchResults((data.collections || []).map((c: any) => ({
          id: c.id, title: c.title, imageUrl: c.imageUrl,
          detail: c.productsCount != null ? `${c.productsCount} products` : null,
        })));
      } else {
        setSearchResults((data.products || []).map((p: any) => ({
          id: p.id, title: p.title, imageUrl: p.imageUrl,
          detail: p.price ? `From $${p.price}` : null,
        })));
      }
    } catch (err: any) {
      setSearchError(err.message || 'Network error during search. Please try again.');
    } finally {
      setSearchLoading(false);
    }
  }, [authenticatedFetch]);

  // Debounced search
  useEffect(() => {
    if (!showCreateModal || wizardStep !== 1) return;
    const t = setTimeout(() => runSearch(searchTab, searchQuery), 350);
    return () => clearTimeout(t);
  }, [searchQuery, searchTab, showCreateModal, wizardStep, runSearch]);

  const toggleSource = (item: ResourceItem) => {
    setSelectedSources((prev) => {
      const exists = prev.some((s) => s.id === item.id);
      if (exists) return prev.filter((s) => s.id !== item.id);
      return [...prev, { type: searchTab, id: item.id, title: item.title }];
    });
  };

  const removeSource = (id: string) => setSelectedSources((prev) => prev.filter((s) => s.id !== id));

  const handleCreateCatalog = async () => {
    if (!newCatalogName.trim()) { showToast('Catalog name is required'); return; }
    if (selectedSources.length === 0) { showToast('Select at least one product or collection'); return; }
    setCreatingCatalog(true);
    try {
      const payload = {
        name: newCatalogName.trim(),
        priceMode: newPriceMode,
        discountPercent: newPriceMode === 'PERCENT_DISCOUNT' ? Number(newDiscount) : 0,
        accentColor: newAccentColor,
        showSku: true,
        showInventory: false,
        sources: selectedSources.map((s) => ({ type: s.type, shopifyGid: s.id })),
      };
      const res = await authenticatedFetch('/api/admin/catalogs', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || 'Failed to create catalog');
      }
      const { catalog: created } = await res.json();
      // Optionally publish right away
      if (newPublish && created?.id) {
        const pubRes = await authenticatedFetch(`/api/admin/catalogs/${created.id}/publish`, {
          method: 'POST',
        });
        if (!pubRes.ok) {
          const pd = await pubRes.json();
          showToast(`Catalog created but could not publish: ${pd.error || 'unknown error'}`);
        } else {
          showToast('Catalog created and published!');
        }
      } else {
        showToast('Catalog created in Draft status!');
      }
      setShowCreateModal(false);
      loadData();
    } catch (err: any) {
      showToast(`Error: ${err.message}`);
    } finally {
      setCreatingCatalog(false);
    }
  };

  return (
    <div className="cf-merchant-container">
      {/* Notifications Toast */}
      {toastMessage && <div className="cf-toast">{toastMessage}</div>}

      {/* Header Bar */}
      <header className="cf-merchant-header">
        <div className="cf-merchant-brand">
          <div className="cf-logo-icon">B2B</div>
          <div>
            <h1 className="cf-merchant-title">CatalogFlow</h1>
            <p className="cf-merchant-subtitle">Wholesale Buyer Ordering & Draft Orders</p>
          </div>
        </div>

        <div className="cf-header-actions">
          {shop && (
            <div className="cf-store-tag">
              <span>🏬</span>
              <span>{shop.shopDomain}</span>
            </div>
          )}
          <button
            type="button"
            className="cf-btn cf-btn-secondary"
            onClick={handleManualSync}
            disabled={syncing}
          >
            {syncing ? 'Syncing...' : '🔄 Sync Shopify Data'}
          </button>
        </div>
      </header>

      {/* Navigation Tabs */}
      <nav className="cf-tabs">
        <button
          className={`cf-tab ${activeTab === 'overview' ? 'active' : ''}`}
          onClick={() => setActiveTab('overview')}
        >
          📊 Dashboard
        </button>
        <button
          className={`cf-tab ${activeTab === 'catalogs' ? 'active' : ''}`}
          onClick={() => setActiveTab('catalogs')}
        >
          📑 Catalogs ({catalogs.length})
        </button>
        <button
          className={`cf-tab ${activeTab === 'submissions' ? 'active' : ''}`}
          onClick={() => setActiveTab('submissions')}
        >
          📦 Submissions ({submissionsTotal})
        </button>
        <button
          className={`cf-tab ${activeTab === 'sync' ? 'active' : ''}`}
          onClick={() => setActiveTab('sync')}
        >
          ⚡ Sync Health
        </button>
        <button
          className={`cf-tab ${activeTab === 'billing' ? 'active' : ''}`}
          onClick={() => setActiveTab('billing')}
        >
          💳 Billing & Quotas
        </button>
      </nav>

      <main className="cf-merchant-main">
        {loading && (
          <div className="cf-card cf-state-card">
            <div className="cf-spinner"></div>
            <h2 className="cf-state-title">Loading CatalogFlow Operations...</h2>
            <p className="cf-state-desc">Fetching live catalogs, sync runs, and draft order submissions...</p>
          </div>
        )}

        {error && !loading && (
          <div className="cf-card cf-state-card cf-error-card">
            <div className="cf-error-icon">⚠️</div>
            <h2 className="cf-state-title">Admin Connection Error</h2>
            <p className="cf-state-desc">{error}</p>
            <button type="button" className="cf-btn cf-btn-primary" onClick={loadData}>
              Retry
            </button>
          </div>
        )}

        {!loading && !error && (
          <>
            {/* OVERVIEW TAB */}
            {activeTab === 'overview' && (
              <div className="cf-tab-content">
                {/* KPI Metrics */}
                <div className="cf-kpi-grid">
                  <div className="cf-kpi-card">
                    <span className="cf-kpi-label">Active Catalogs</span>
                    <span className="cf-kpi-value">
                      {catalogs.filter((c) => c.status === 'PUBLISHED').length}
                    </span>
                    <span className="cf-kpi-sub">Total: {catalogs.length}</span>
                  </div>

                  <div className="cf-kpi-card">
                    <span className="cf-kpi-label">Monthly Orders</span>
                    <span className="cf-kpi-value">
                      {quota?.usage.monthlySubmissionsCount || 0}
                    </span>
                    <span className="cf-kpi-sub">
                      Limit: {quota?.limits.monthlySubmissionsLimit || 50} / mo
                    </span>
                  </div>

                  <div className="cf-kpi-card">
                    <span className="cf-kpi-label">Mirrored Products</span>
                    <span className="cf-kpi-value">
                      {syncHealth?.inventory.productsCount || 0}
                    </span>
                    <span className="cf-kpi-sub">
                      {syncHealth?.inventory.variantsCount || 0} variants
                    </span>
                  </div>

                  <div className="cf-kpi-card">
                    <span className="cf-kpi-label">Plan Tier</span>
                    <span className="cf-kpi-value">{quota?.planTier || 'STARTER'}</span>
                    <span className="cf-kpi-sub">
                      {quota?.allowed.canAcceptSubmission ? '✅ Quota Normal' : '⚠️ Limit Reached'}
                    </span>
                  </div>
                </div>

                {/* Product Analytics & Funnel (M8) */}
                {analytics && (
                  <div className="cf-card" style={{ padding: '1.5rem', marginBottom: '1.5rem' }}>
                    <div className="cf-section-header" style={{ marginBottom: '0.75rem' }}>
                      <div>
                        <h3 style={{ margin: 0, fontSize: '1.1rem' }}>Commercial Funnel & Product Analytics</h3>
                        <p className="cf-section-desc">Real-time buyer engagement and Draft Order conversion rate (Last 30 Days)</p>
                      </div>
                      <span className="cf-badge cf-badge-info">North Star: Draft Orders Created</span>
                    </div>

                    <div className="cf-funnel-grid">
                      <div className="cf-funnel-card">
                        <div className="cf-funnel-step">Step 1 • Traffic</div>
                        <div className="cf-funnel-value">{analytics.counts.catalogViews}</div>
                        <div className="cf-funnel-pct">Catalog Views</div>
                      </div>

                      <div className="cf-funnel-card">
                        <div className="cf-funnel-step">Step 2 • Engagement</div>
                        <div className="cf-funnel-value">{analytics.counts.orderSummariesStarted}</div>
                        <div className="cf-funnel-pct">{analytics.conversionRates.viewToSummaryPct}% of Views</div>
                      </div>

                      <div className="cf-funnel-card">
                        <div className="cf-funnel-step">Step 3 • Orders</div>
                        <div className="cf-funnel-value">{analytics.counts.ordersSubmitted}</div>
                        <div className="cf-funnel-pct">{analytics.conversionRates.summaryToSubmitPct}% of Carts</div>
                      </div>

                      <div className="cf-funnel-card highlight">
                        <div className="cf-funnel-step">Step 4 • North Star</div>
                        <div className="cf-funnel-value">{analytics.counts.draftOrdersCreated}</div>
                        <div className="cf-funnel-pct">🎯 {analytics.conversionRates.overallConversionPct}% Overall Conv.</div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Quota Progress Bar */}
                {quota && (
                  <div className="cf-card cf-quota-card">
                    <div className="cf-quota-header">
                      <div>
                        <strong>Monthly Submission Quota Usage</strong>
                        <p className="cf-quota-desc">
                          {quota.usage.monthlySubmissionsCount} of {quota.limits.monthlySubmissionsLimit} draft orders used this billing cycle
                        </p>
                      </div>
                      <button
                        type="button"
                        className="cf-btn cf-btn-sm cf-btn-secondary"
                        onClick={() => setActiveTab('billing')}
                      >
                        Manage Plan & Quotas →
                      </button>
                    </div>
                    <div className="cf-progress-bar-bg">
                      <div
                        className={`cf-progress-bar-fill ${
                          (quota.usage.monthlySubmissionsCount / quota.limits.monthlySubmissionsLimit) >= 0.9
                            ? 'danger'
                            : ''
                        }`}
                        style={{
                          width: `${Math.min(
                            100,
                            (quota.usage.monthlySubmissionsCount / quota.limits.monthlySubmissionsLimit) * 100
                          )}%`,
                        }}
                      />
                    </div>
                  </div>
                )}

                {/* Quick Actions & Recent Submissions */}
                <div className="cf-overview-section">
                  <div className="cf-section-header">
                    <h3>Recent Buyer Submissions</h3>
                    <button
                      className="cf-btn cf-btn-link"
                      onClick={() => setActiveTab('submissions')}
                    >
                      View All ({submissionsTotal}) →
                    </button>
                  </div>

                  {submissions.length === 0 ? (
                    <div className="cf-empty-state">
                      <p>Test the buyer experience yourself — your first submission will appear as a Draft Order.</p>
                      {catalogs.length > 0 && catalogs[0].status === 'PUBLISHED' && (
                        <button
                          className="cf-btn cf-btn-secondary"
                          onClick={() => handleCopyLink(catalogs[0].publicToken)}
                        >
                          📋 Copy Live Catalog Link
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="cf-table-container">
                      <table className="cf-table">
                        <thead>
                          <tr>
                            <th>Draft Order</th>
                            <th>Catalog</th>
                            <th>Items</th>
                            <th>Total</th>
                            <th>Status</th>
                            <th>Date</th>
                            <th>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {submissions.slice(0, 5).map((sub) => (
                            <tr key={sub.id}>
                              <td>
                                <strong>{sub.draftOrderName || 'Draft Order'}</strong>
                              </td>
                              <td>{sub.catalogName}</td>
                              <td>{sub.itemCount} items ({sub.lineCount} lines)</td>
                              <td>{sub.formattedSubtotal}</td>
                              <td>
                                <span
                                  className={`cf-badge ${
                                    sub.status === 'COMPLETED'
                                      ? 'cf-badge-completed'
                                      : sub.status === 'FAILED'
                                      ? 'cf-badge-failed'
                                      : sub.status === 'REQUIRES_RECONCILIATION'
                                      ? 'cf-badge-reconciliation'
                                      : 'cf-badge-creating'
                                  }`}
                                >
                                  {sub.status || 'COMPLETED'}
                                </span>
                              </td>
                              <td>{new Date(sub.createdAt).toLocaleDateString()}</td>
                              <td>
                                {sub.draftOrderUrl ? (
                                  <a
                                    href={sub.draftOrderUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="cf-btn cf-btn-sm cf-btn-primary"
                                  >
                                    Open Draft Order ↗
                                  </a>
                                ) : (
                                  <span className="cf-text-muted">Saved</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* CATALOGS TAB */}
            {activeTab === 'catalogs' && (
              <div className="cf-tab-content">
                <div className="cf-section-header">
                  <div>
                    <h3>Wholesale Catalogs</h3>
                    <p className="cf-section-desc">Create distinct catalogs with custom discounts and share direct links with B2B buyers.</p>
                  </div>
                  <button
                    className="cf-btn cf-btn-primary"
                      onClick={openCreateWizard}
                    id="cf-create-catalog-btn"
                  >
                    + Create Catalog
                  </button>
                </div>

                {catalogs.length === 0 ? (
                  <div className="cf-empty-state">
                    <p>Create your first wholesale catalog in under 10 minutes.</p>
                    <button
                      className="cf-btn cf-btn-primary"
                    onClick={openCreateWizard}
                    >
                      Create Your First Catalog
                    </button>
                  </div>
                ) : (
                  <div className="cf-table-container">
                    <table className="cf-table">
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Status</th>
                          <th>Inventory Scope</th>
                          <th>Pricing Rule</th>
                          <th>Buyer Link</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {catalogs.map((cat) => (
                          <tr key={cat.id}>
                            <td>
                              <strong>{cat.name}</strong>
                            </td>
                            <td>
                              <span
                                className={`cf-badge ${
                                  cat.status === 'PUBLISHED' ? 'cf-badge-success' : 'cf-badge-outline'
                                }`}
                              >
                                {cat.status}
                              </span>
                            </td>
                            <td>
                              <span style={{ fontSize: '0.86rem' }}>
                                {cat.variantCount ?? 0} variants ({cat.productCount ?? 0} products)
                              </span>
                            </td>
                            <td>
                              {cat.priceMode === 'PERCENT_DISCOUNT'
                                ? `${cat.discountPercent}% Wholesale Discount`
                                : 'Shopify Retail Price'}
                            </td>
                            <td>
                              {cat.status === 'PUBLISHED' ? (
                                <div style={{ display: 'flex', gap: '0.4rem' }}>
                                  <button
                                    className="cf-btn cf-btn-sm cf-btn-secondary"
                                    onClick={() => handleCopyLink(cat.publicToken)}
                                    title="Copy buyer link"
                                  >
                                    📋 Copy
                                  </button>
                                  <a
                                    href={`/c/${cat.publicToken}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="cf-btn cf-btn-sm cf-btn-outline"
                                    title="Open catalog preview"
                                  >
                                    Preview ↗
                                  </a>
                                </div>
                              ) : (
                                <span className="cf-text-muted">Unpublished (Draft)</span>
                              )}
                            </td>
                            <td>
                              <button
                                className="cf-btn cf-btn-sm cf-btn-outline"
                                onClick={() => handlePublishToggle(cat)}
                              >
                                {cat.status === 'PUBLISHED' ? 'Unpublish' : 'Publish'}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* SUBMISSIONS TAB */}
            {activeTab === 'submissions' && (
              <div className="cf-tab-content">
                <div className="cf-section-header">
                  <div>
                    <h3>Wholesale Submissions History</h3>
                    <p className="cf-section-desc">
                      Every submission automatically creates a native Shopify Draft Order. No raw customer PII is stored locally.
                    </p>
                  </div>
                </div>

                <div className="cf-filter-bar">
                  <div className="cf-filter-group">
                    <label style={{ fontSize: '0.84rem', fontWeight: 600 }}>Filter by Status:</label>
                    <select
                      className="cf-select"
                      value={submissionStatusFilter}
                      onChange={(e) => setSubmissionStatusFilter(e.target.value)}
                    >
                      <option value="ALL">All Submissions</option>
                      <option value="COMPLETED">Completed Only</option>
                      <option value="FAILED">Failed</option>
                      <option value="REQUIRES_RECONCILIATION">Reconciliation Needed</option>
                    </select>
                  </div>
                  <span className="cf-text-muted" style={{ fontSize: '0.84rem' }}>
                    Showing {submissions.length} of {submissionsTotal} entries
                  </span>
                </div>

                {submissions.length === 0 ? (
                  <div className="cf-empty-state">
                    <p>Test the buyer experience yourself — your first submission will appear as a Draft Order.</p>
                  </div>
                ) : (
                  <div className="cf-table-container">
                    <table className="cf-table">
                      <thead>
                        <tr>
                          <th>Draft Order</th>
                          <th>Catalog</th>
                          <th>Items</th>
                          <th>Total</th>
                          <th>Status</th>
                          <th>Date</th>
                          <th>Shopify Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {submissions.map((sub) => (
                          <tr key={sub.id}>
                            <td>
                              <strong>{sub.draftOrderName || 'Draft Order'}</strong>
                              {sub.lastError && (
                                <div style={{ fontSize: '0.75rem', color: '#c52707', marginTop: '0.2rem' }}>
                                  {sub.lastError}
                                </div>
                              )}
                            </td>
                            <td>{sub.catalogName}</td>
                            <td>{sub.itemCount} items ({sub.lineCount} lines)</td>
                            <td>{sub.formattedSubtotal}</td>
                            <td>
                              <span
                                className={`cf-badge ${
                                  sub.status === 'COMPLETED'
                                    ? 'cf-badge-completed'
                                    : sub.status === 'FAILED'
                                    ? 'cf-badge-failed'
                                    : sub.status === 'REQUIRES_RECONCILIATION'
                                    ? 'cf-badge-reconciliation'
                                    : 'cf-badge-creating'
                                }`}
                              >
                                {sub.status || 'COMPLETED'}
                              </span>
                            </td>
                            <td>{new Date(sub.createdAt).toLocaleString()}</td>
                            <td>
                              {sub.draftOrderUrl ? (
                                <a
                                  href={sub.draftOrderUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="cf-btn cf-btn-sm cf-btn-primary"
                                >
                                  Open in Shopify ↗
                                </a>
                              ) : sub.status === 'REQUIRES_RECONCILIATION' ? (
                                <button
                                  className="cf-btn cf-btn-sm cf-btn-warning"
                                  onClick={() => handleReconcileSubmission(sub.id)}
                                  disabled={reconcilingId === sub.id}
                                  title="Check if Shopify has processed the order mutation"
                                >
                                  {reconcilingId === sub.id ? 'Checking...' : 'Check Shopify ↻'}
                                </button>
                              ) : (
                                <span className="cf-text-muted">No Shopify Link</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* SYNC HEALTH TAB */}
            {activeTab === 'sync' && (
              <div className="cf-tab-content">
                <div className="cf-section-header">
                  <div>
                    <h3>Shopify Catalog Sync Diagnostics</h3>
                    <p className="cf-section-desc">
                      CatalogFlow maintains real-time snapshots via webhooks and handles inventory changes automatically.
                    </p>
                  </div>
                </div>

                <div className="cf-card" style={{ padding: '1.5rem', marginBottom: '1.5rem' }}>
                  <div className="cf-summary-grid">
                    <div className="cf-summary-box">
                      <span className="cf-summary-label">Sync Status</span>
                      <span className="cf-summary-value">
                        {syncHealth?.sync.status === 'IN_PROGRESS' ? '⏳ Syncing' : '✅ Active & Synced'}
                      </span>
                      <span className="cf-summary-hint">
                        Last sync: {syncHealth?.sync.lastSyncAt ? new Date(syncHealth.sync.lastSyncAt).toLocaleString() : 'Just now'}
                      </span>
                    </div>

                    <div className="cf-summary-box">
                      <span className="cf-summary-label">Mirrored Products</span>
                      <span className="cf-summary-value">{syncHealth?.inventory.productsCount || 0}</span>
                      <span className="cf-summary-hint">
                        {syncHealth?.inventory.variantsCount || 0} total active variants
                      </span>
                    </div>

                    <div className="cf-summary-box">
                      <span className="cf-summary-label">Initial Bootstrap</span>
                      <span className="cf-summary-value">
                        {syncHealth?.shop.initialSyncAt ? 'Completed' : 'Pending'}
                      </span>
                      <span className="cf-summary-hint">
                        {syncHealth?.shop.initialSyncAt ? new Date(syncHealth.shop.initialSyncAt).toLocaleDateString() : 'Running'}
                      </span>
                    </div>

                    <div className="cf-summary-box">
                      <span className="cf-summary-label">Collections Mapped</span>
                      <span className="cf-summary-value">{syncHealth?.inventory.collectionsCount || 0}</span>
                      <span className="cf-summary-hint">Available for catalog rules</span>
                    </div>

                    <div className="cf-summary-box">
                      <span className="cf-summary-label">Background Jobs</span>
                      <span className="cf-summary-value">
                        {syncHealth?.jobs ? (
                          syncHealth.jobs.failed > 0 ? (
                            <span style={{ color: 'var(--color-danger, #dc2626)' }}>
                              {syncHealth.jobs.failed} Failed
                            </span>
                          ) : (
                            <span style={{ color: 'var(--color-success, #16a34a)' }}>
                              ✅ All Healthy
                            </span>
                          )
                        ) : (
                          '0 Failed'
                        )}
                      </span>
                      <span className="cf-summary-hint">
                        {syncHealth?.jobs?.pending || 0} pending in worker queue
                      </span>
                    </div>
                  </div>

                  {syncHealth?.jobs && syncHealth.jobs.failed > 0 && (
                    <div
                      style={{
                        marginTop: '1.25rem',
                        padding: '1rem',
                        background: '#fef2f2',
                        border: '1px solid #fecaca',
                        borderRadius: '6px',
                        color: '#991b1b',
                        fontSize: '0.875rem',
                      }}
                    >
                      <strong>⚠️ Background Job Warning:</strong> {syncHealth.jobs.failed} background sync job(s) failed.{' '}
                      {syncHealth.jobs.lastError && (
                        <span>Latest issue: <em>{syncHealth.jobs.lastError}</em></span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* BILLING & PLANS TAB (M8) */}
            {activeTab === 'billing' && (
              <div className="cf-tab-content">
                <div className="cf-section-header">
                  <div>
                    <h3>Billing, Plans & Quota Limits</h3>
                    <p className="cf-section-desc">
                      Predictable wholesale pricing with hard caps and zero surprise overages.
                    </p>
                  </div>
                  {billing && (
                    <span className="cf-badge cf-badge-info" style={{ fontSize: '0.9rem', padding: '0.4rem 0.8rem' }}>
                      Current Plan: {billing.currentPlan}
                    </span>
                  )}
                </div>

                {billing && (
                  <div className="cf-card" style={{ padding: '1.5rem', marginBottom: '1.5rem' }}>
                    <h4 style={{ margin: '0 0 1rem', fontSize: '1.1rem' }}>Active Billing Cycle & Quota Utilization</h4>
                    
                    <div className="cf-summary-grid" style={{ marginBottom: '1.5rem' }}>
                      <div className="cf-summary-box">
                        <span className="cf-summary-label">Live Catalogs</span>
                        <span className="cf-summary-value">
                          {billing.usage.liveCatalogsCount} / {billing.limits.maxLiveCatalogs}
                        </span>
                        <span className="cf-summary-hint">
                          {billing.allowed.canPublishCatalog ? 'Quota Available' : 'Limit Reached'}
                        </span>
                      </div>

                      <div className="cf-summary-box">
                        <span className="cf-summary-label">Max Variants / Catalog</span>
                        <span className="cf-summary-value">
                          {billing.usage.maxVariantsInPublishedCatalogs} / {billing.limits.maxVariants}
                        </span>
                        <span className="cf-summary-hint">Checked upon catalog publish</span>
                      </div>

                      <div className="cf-summary-box">
                        <span className="cf-summary-label">Monthly Orders</span>
                        <span className="cf-summary-value">
                          {billing.usage.monthlySubmissionsCount} / {billing.limits.monthlySubmissionsLimit}
                        </span>
                        <span className="cf-summary-hint">
                          Next Reset: {new Date(billing.usage.nextBillingCycleAt).toLocaleDateString()}
                        </span>
                      </div>
                    </div>

                    <div className="cf-quota-header" style={{ marginBottom: '0.4rem' }}>
                      <span>Draft Order Quota Usage</span>
                      <span>
                        {Math.round((billing.usage.monthlySubmissionsCount / billing.limits.monthlySubmissionsLimit) * 100)}%
                      </span>
                    </div>
                    <div className="cf-progress-bar-bg">
                      <div
                        className={`cf-progress-bar-fill ${
                          (billing.usage.monthlySubmissionsCount / billing.limits.monthlySubmissionsLimit) >= 0.9
                            ? 'danger'
                            : ''
                        }`}
                        style={{
                          width: `${Math.min(
                            100,
                            (billing.usage.monthlySubmissionsCount / billing.limits.monthlySubmissionsLimit) * 100
                          )}%`,
                        }}
                      />
                    </div>
                  </div>
                )}

                {/* Plan Comparison Grid */}
                <h4 style={{ margin: '1.5rem 0 0.5rem', fontSize: '1.15rem' }}>Available Subscription Plans</h4>
                <p className="cf-section-desc">Switch plan tiers instantly with automated quota adjustment.</p>

                <div className="cf-plans-grid">
                  {/* Billing availability notice */}
                  {billingUnavailable && (
                    <div style={{
                      gridColumn: '1 / -1',
                      padding: '1rem 1.25rem',
                      background: '#fef3c7',
                      border: '1px solid #fcd34d',
                      borderRadius: '8px',
                      marginBottom: '1rem',
                      fontSize: '0.9rem',
                      color: '#92400e',
                    }}>
                      <strong>⚠️ Plan management is handled by Shopify App Pricing.</strong>
                      {' '}To upgrade or change your plan, visit your Shopify Admin → Apps → CatalogFlow → Billing.
                      Plan-switching within this panel is not yet active for this installation.
                    </div>
                  )}
                  {billing?.availablePlans.map((plan) => {
                    const isCurrent = billing.currentPlan === plan.id;
                    return (
                      <div
                        key={plan.id}
                        className={`cf-plan-card ${isCurrent ? 'current' : ''}`}
                      >
                        <div className="cf-plan-header">
                          <div className="cf-plan-title">
                            <h4>{plan.name}</h4>
                            {isCurrent && <span className="cf-badge cf-badge-success">Active Plan</span>}
                          </div>
                          <div className="cf-plan-price">
                            ${plan.price} <span>/ month</span>
                          </div>
                        </div>

                        <ul className="cf-plan-features">
                          {plan.features.map((feat, idx) => (
                            <li key={idx}>{feat}</li>
                          ))}
                        </ul>

                        <div className="cf-plan-action">
                          {isCurrent ? (
                            <button className="cf-btn cf-btn-secondary" style={{ width: '100%' }} disabled>
                              Current Subscription
                            </button>
                          ) : billingUnavailable ? (
                            <button
                              className="cf-btn cf-btn-secondary"
                              style={{ width: '100%' }}
                              disabled
                              title="Plan changes are managed through Shopify App Pricing"
                            >
                              Manage in Shopify Admin
                            </button>
                          ) : (
                            <button
                              className="cf-btn cf-btn-primary"
                              style={{ width: '100%' }}
                              onClick={() => handlePlanChange(plan.id)}
                              disabled={switchingPlan}
                            >
                              {switchingPlan ? 'Updating...' : `Switch to ${plan.name}`}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </main>

      {/* ── Catalog Creation Wizard ─────────────────────────────── */}
      {showCreateModal && (
        <div className="cf-modal-backdrop">
          <div className="cf-modal cf-modal-wide">
            {/* Header */}
            <div className="cf-modal-header">
              <div className="cf-wizard-header-inner">
                <h3>Create Wholesale Catalog</h3>
                <div className="cf-wizard-steps">
                  {[1, 2, 3].map((s) => (
                    <div key={s} className={`cf-wizard-step ${wizardStep === s ? 'active' : ''} ${wizardStep > s ? 'done' : ''}`}>
                      <span className="cf-wizard-dot">{wizardStep > s ? '✓' : s}</span>
                      <span className="cf-wizard-label">{s === 1 ? 'Sources' : s === 2 ? 'Pricing' : 'Details'}</span>
                    </div>
                  ))}
                </div>
              </div>
              <button type="button" className="cf-close-btn" onClick={() => setShowCreateModal(false)}>✕</button>
            </div>

            <div className="cf-modal-body">

              {/* ── STEP 1: Source Selector ──────────────────────── */}
              {wizardStep === 1 && (
                <div className="cf-wizard-pane">
                  <p className="cf-wizard-hint">Select the Shopify collections or products to include in this catalog.</p>

                  {/* Tab toggle */}
                  <div className="cf-seg-tabs">
                    <button
                      type="button"
                      className={`cf-seg-tab ${searchTab === 'COLLECTION' ? 'active' : ''}`}
                      onClick={() => { setSearchTab('COLLECTION'); setSearchQuery(''); setSearchResults([]); }}
                    >
                      Collections
                    </button>
                    <button
                      type="button"
                      className={`cf-seg-tab ${searchTab === 'PRODUCT' ? 'active' : ''}`}
                      onClick={() => { setSearchTab('PRODUCT'); setSearchQuery(''); setSearchResults([]); }}
                    >
                      Products
                    </button>
                  </div>

                  {/* Search input */}
                  <div className="cf-search-bar">
                    <span className="cf-search-icon">🔍</span>
                    <input
                      id="cf-resource-search"
                      type="search"
                      className="cf-input cf-search-input"
                      placeholder={searchTab === 'COLLECTION' ? 'Search collections…' : 'Search products…'}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      autoFocus
                    />
                  </div>

                  {/* Results list */}
                  <div className="cf-resource-list">
                    {searchLoading && <div className="cf-resource-loading"><div className="cf-spinner-sm"></div> Searching…</div>}
                    {/* Search error state — shown distinctly from empty results */}
                  {searchError && (
                    <div className="cf-resource-empty" style={{ color: '#c52707' }}>
                      ⚠️ {searchError}
                    </div>
                  )}
                  {!searchLoading && !searchError && searchResults.length === 0 && searchQuery.length > 0 && (
                      <div className="cf-resource-empty">No {searchTab === 'COLLECTION' ? 'collections' : 'products'} found for "{searchQuery}"</div>
                    )}
                    {!searchLoading && !searchError && searchResults.length === 0 && searchQuery.length === 0 && (
                      <div className="cf-resource-empty">Start typing to search your Shopify {searchTab === 'COLLECTION' ? 'collections' : 'products'}.</div>
                    )}
                    {searchResults.map((item) => {
                      const selected = selectedSources.some((s) => s.id === item.id);
                      return (
                        <button
                          key={item.id}
                          type="button"
                          className={`cf-resource-row ${selected ? 'selected' : ''}`}
                          onClick={() => toggleSource(item)}
                        >
                          <div className="cf-resource-thumb">
                            {item.imageUrl
                              ? <img src={item.imageUrl} alt="" />
                              : <span className="cf-resource-placeholder">{searchTab === 'COLLECTION' ? '📂' : '📦'}</span>}
                          </div>
                          <div className="cf-resource-info">
                            <span className="cf-resource-title">{item.title}</span>
                            {item.detail && <span className="cf-resource-detail">{item.detail}</span>}
                          </div>
                          <div className="cf-resource-check">{selected ? '✓' : ''}</div>
                        </button>
                      );
                    })}
                  </div>

                  {/* Selected sources summary */}
                  {selectedSources.length > 0 && (
                    <div className="cf-selected-sources">
                      <p className="cf-selected-label">Selected ({selectedSources.length})</p>
                      <div className="cf-source-chips">
                        {selectedSources.map((s) => (
                          <span key={s.id} className="cf-source-chip">
                            {s.type === 'COLLECTION' ? '📂' : '📦'} {s.title}
                            <button type="button" className="cf-chip-remove" onClick={() => removeSource(s.id)}>×</button>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ── STEP 2: Pricing ─────────────────────────────── */}
              {wizardStep === 2 && (
                <div className="cf-wizard-pane">
                  <p className="cf-wizard-hint">Choose how prices will be shown to your wholesale buyers.</p>

                  <div className="cf-pricing-options">
                    <label className={`cf-pricing-card ${newPriceMode === 'SHOPIFY_PRICE' ? 'selected' : ''}`}>
                      <input
                        type="radio"
                        name="priceMode"
                        value="SHOPIFY_PRICE"
                        checked={newPriceMode === 'SHOPIFY_PRICE'}
                        onChange={() => setNewPriceMode('SHOPIFY_PRICE')}
                      />
                      <div className="cf-pricing-card-inner">
                        <span className="cf-pricing-icon">🏷️</span>
                        <span className="cf-pricing-name">Shopify Retail Price</span>
                        <span className="cf-pricing-desc">Show prices exactly as set in your Shopify product listings.</span>
                      </div>
                    </label>

                    <label className={`cf-pricing-card ${newPriceMode === 'PERCENT_DISCOUNT' ? 'selected' : ''}`}>
                      <input
                        type="radio"
                        name="priceMode"
                        value="PERCENT_DISCOUNT"
                        checked={newPriceMode === 'PERCENT_DISCOUNT'}
                        onChange={() => setNewPriceMode('PERCENT_DISCOUNT')}
                      />
                      <div className="cf-pricing-card-inner">
                        <span className="cf-pricing-icon">💸</span>
                        <span className="cf-pricing-name">Catalog-Wide Wholesale Discount</span>
                        <span className="cf-pricing-desc">Apply a uniform % discount off Shopify prices for all items in this catalog.</span>
                      </div>
                    </label>
                  </div>

                  {newPriceMode === 'PERCENT_DISCOUNT' && (
                    <div className="cf-form-group cf-discount-group">
                      <label htmlFor="cf-discount-pct">Discount Percentage</label>
                      <div className="cf-discount-row">
                        <input
                          id="cf-discount-pct"
                          type="number"
                          min={1}
                          max={90}
                          value={newDiscount}
                          onChange={(e) => setNewDiscount(Math.min(90, Math.max(1, Number(e.target.value))))}
                          className="cf-input cf-input-sm"
                        />
                        <span className="cf-discount-pct-label">% off retail</span>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ── STEP 3: Details ─────────────────────────────── */}
              {wizardStep === 3 && (
                <div className="cf-wizard-pane">
                  <p className="cf-wizard-hint">Name your catalog and set branding. You can publish immediately or save as a draft first.</p>

                  <div className="cf-form-group">
                    <label htmlFor="cf-catalog-name">Catalog Name <span className="cf-required">*</span></label>
                    <input
                      id="cf-catalog-name"
                      type="text"
                      required
                      placeholder="e.g. Summer 2026 Wholesale"
                      value={newCatalogName}
                      onChange={(e) => setNewCatalogName(e.target.value)}
                      className="cf-input"
                      autoFocus
                    />
                  </div>

                  <div className="cf-form-group">
                    <label htmlFor="cf-accent-color">Buyer Portal Accent Color</label>
                    <div className="cf-color-row">
                      <input
                        id="cf-accent-color"
                        type="color"
                        value={newAccentColor}
                        onChange={(e) => setNewAccentColor(e.target.value)}
                        className="cf-color-input"
                      />
                      <span className="cf-color-hex">{newAccentColor}</span>
                    </div>
                  </div>

                  {/* Summary */}
                  <div className="cf-wizard-summary">
                    <h4>Summary</h4>
                    <div className="cf-summary-row"><span>Sources</span><span>{selectedSources.length} selected</span></div>
                    <div className="cf-summary-row"><span>Pricing</span><span>{newPriceMode === 'SHOPIFY_PRICE' ? 'Shopify Price' : `${newDiscount}% Discount`}</span></div>
                  </div>

                  <label className="cf-publish-toggle">
                    <input
                      type="checkbox"
                      checked={newPublish}
                      onChange={(e) => setNewPublish(e.target.checked)}
                      id="cf-publish-on-create"
                    />
                    <span>Publish immediately after creation</span>
                  </label>
                </div>
              )}

            </div>{/* cf-modal-body */}

            {/* Footer nav */}
            <div className="cf-modal-footer">
              {wizardStep === 1 && (
                <button type="button" className="cf-btn cf-btn-secondary" onClick={() => setShowCreateModal(false)}>Cancel</button>
              )}
              {wizardStep > 1 && (
                <button type="button" className="cf-btn cf-btn-secondary" onClick={() => setWizardStep((wizardStep - 1) as 1 | 2 | 3)}>← Back</button>
              )}
              {wizardStep < 3 && (
                <button
                  type="button"
                  className="cf-btn cf-btn-primary"
                  disabled={wizardStep === 1 && selectedSources.length === 0}
                  onClick={() => setWizardStep((wizardStep + 1) as 2 | 3)}
                >
                  Next →
                </button>
              )}
              {wizardStep === 3 && (
                <button
                  type="button"
                  className="cf-btn cf-btn-primary"
                  disabled={creatingCatalog || !newCatalogName.trim()}
                  onClick={handleCreateCatalog}
                >
                  {creatingCatalog ? 'Creating…' : newPublish ? 'Create & Publish' : 'Create Draft'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
