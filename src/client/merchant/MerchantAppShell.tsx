import React, { useState, useEffect, useCallback } from 'react';
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
  sources: Array<{ type: 'COLLECTION' | 'PRODUCT'; shopifyGid: string }>;
}

interface OrderSubmissionItem {
  id: string;
  catalogId: string;
  catalogName: string;
  catalogPublicToken: string;
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
}

type TabType = 'overview' | 'catalogs' | 'submissions' | 'sync';

export const MerchantAppShell: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabType>('overview');
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [shop, setShop] = useState<ShopInfo | null>(null);
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  const [catalogs, setCatalogs] = useState<CatalogSummary[]>([]);
  const [submissions, setSubmissions] = useState<OrderSubmissionItem[]>([]);
  const [submissionsTotal, setSubmissionsTotal] = useState<number>(0);
  const [submissionsPage, setSubmissionsPage] = useState<number>(1);
  const [syncHealth, setSyncHealth] = useState<SyncHealthData | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<boolean>(false);

  // New catalog modal state
  const [showCreateModal, setShowCreateModal] = useState<boolean>(false);
  const [newCatalogName, setNewCatalogName] = useState<string>('');
  const [newPriceMode, setNewPriceMode] = useState<'SHOPIFY_PRICE' | 'PERCENT_DISCOUNT'>('SHOPIFY_PRICE');
  const [newDiscount, setNewDiscount] = useState<number>(10);
  const [newAccentColor, setNewAccentColor] = useState<string>('#108043');
  const [newSourceType, setNewSourceType] = useState<'COLLECTION' | 'PRODUCT'>('COLLECTION');
  const [newSourceGid, setNewSourceGid] = useState<string>('');
  const [creatingCatalog, setCreatingCatalog] = useState<boolean>(false);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  const getAuthHeaders = useCallback(async (): Promise<Record<string, string>> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (typeof window !== 'undefined' && (window as any).shopify?.idToken) {
      try {
        const token = await (window as any).shopify.idToken();
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
      } catch {
        // App Bridge fetch interceptor fallback
      }
    }
    return headers;
  }, []);

  const loadData = useCallback(async () => {
    try {
      const headers = await getAuthHeaders();

      // Bootstrap & Shop
      const bootstrapRes = await fetch('/api/admin/bootstrap', { method: 'POST', headers });
      if (!bootstrapRes.ok) throw new Error('Authentication failed');
      const bootstrapData = await bootstrapRes.json();
      setShop(bootstrapData.shop);

      // Quota
      const quotaRes = await fetch('/api/admin/quota', { headers });
      if (quotaRes.ok) {
        setQuota(await quotaRes.json());
      }

      // Catalogs
      const catRes = await fetch('/api/admin/catalogs', { headers });
      if (catRes.ok) {
        const catData = await catRes.json();
        setCatalogs(catData.catalogs || []);
      }

      // Submissions
      const subRes = await fetch(`/api/admin/submissions?page=${submissionsPage}&pageSize=10`, { headers });
      if (subRes.ok) {
        const subData = await subRes.json();
        setSubmissions(subData.submissions || []);
        setSubmissionsTotal(subData.totalCount || 0);
      }

      // Sync Health
      const syncRes = await fetch('/api/admin/sync/health', { headers });
      if (syncRes.ok) {
        setSyncHealth(await syncRes.json());
      }
    } catch (err: any) {
      setError(err.message || 'Failed to initialize embedded portal');
    } finally {
      setLoading(false);
    }
  }, [getAuthHeaders, submissionsPage]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handlePublishToggle = async (cat: CatalogSummary) => {
    const endpoint = cat.status === 'PUBLISHED' ? 'unpublish' : 'publish';
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`/api/admin/catalogs/${cat.id}/${endpoint}`, {
        method: 'POST',
        headers,
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
      const headers = await getAuthHeaders();
      const res = await fetch('/api/admin/sync/trigger', { method: 'POST', headers });
      if (!res.ok) throw new Error('Failed to start sync');
      showToast('Catalog sync initiated in background.');
      setTimeout(() => {
        loadData();
        setSyncing(false);
      }, 2500);
    } catch (err: any) {
      showToast(`Sync trigger failed: ${err.message}`);
      setSyncing(false);
    }
  };

  const handleCreateCatalog = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCatalogName.trim()) return;
    setCreatingCatalog(true);
    try {
      const headers = await getAuthHeaders();
      const payload: any = {
        name: newCatalogName.trim(),
        priceMode: newPriceMode,
        discountPercent: newPriceMode === 'PERCENT_DISCOUNT' ? Number(newDiscount) : 0,
        accentColor: newAccentColor,
        showSku: true,
        showInventory: false,
        sources: [
          {
            type: newSourceType,
            shopifyGid: newSourceGid.trim() || 'gid://shopify/Collection/all',
          },
        ],
      };

      const res = await fetch('/api/admin/catalogs', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to create catalog');
      }

      showToast('Wholesale catalog created successfully!');
      setShowCreateModal(false);
      setNewCatalogName('');
      setNewSourceGid('');
      loadData();
    } catch (err: any) {
      showToast(`Error: ${err.message}`);
    } finally {
      setCreatingCatalog(false);
    }
  };

  return (
    <div className="cf-merchant-container">
      {/* Toast Notification */}
      {toastMessage && <div className="cf-toast">{toastMessage}</div>}

      <header className="cf-merchant-header">
        <div className="cf-merchant-brand">
          <div className="cf-logo-icon">CF</div>
          <div>
            <h1 className="cf-merchant-title">CatalogFlow</h1>
            <p className="cf-merchant-subtitle">B2B Catalog & Buyer Wholesale Portal</p>
          </div>
        </div>
        <div className="cf-header-actions">
          {shop && (
            <div className="cf-store-tag">
              <span className="cf-status-dot"></span>
              {shop.shopDomain}
            </div>
          )}
          <button
            type="button"
            className="cf-btn cf-btn-secondary"
            onClick={handleManualSync}
            disabled={syncing}
            id="cf-sync-header-btn"
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
                      <span className="cf-badge cf-badge-info">{quota.planTier} Plan</span>
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
                      <p>No buyer submissions recorded yet. Share a catalog link to begin receiving wholesale orders!</p>
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
                    onClick={() => setShowCreateModal(true)}
                    id="cf-create-catalog-btn"
                  >
                    + Create Catalog
                  </button>
                </div>

                {catalogs.length === 0 ? (
                  <div className="cf-empty-state">
                    <p>No wholesale catalogs created yet.</p>
                    <button
                      className="cf-btn cf-btn-primary"
                      onClick={() => setShowCreateModal(true)}
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
                          <th>Pricing Rule</th>
                          <th>Public Buyer Link</th>
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
                              {cat.priceMode === 'PERCENT_DISCOUNT'
                                ? `${cat.discountPercent}% Wholesale Discount`
                                : 'Shopify Retail Price'}
                            </td>
                            <td>
                              {cat.status === 'PUBLISHED' ? (
                                <button
                                  className="cf-btn cf-btn-sm cf-btn-secondary"
                                  onClick={() => handleCopyLink(cat.publicToken)}
                                  title="Copy buyer link"
                                >
                                  📋 Copy Link
                                </button>
                              ) : (
                                <span className="cf-text-muted">Unpublished (Inactive)</span>
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

                {submissions.length === 0 ? (
                  <div className="cf-empty-state">
                    <p>No buyer order submissions received yet.</p>
                  </div>
                ) : (
                  <div className="cf-table-container">
                    <table className="cf-table">
                      <thead>
                        <tr>
                          <th>Draft Order</th>
                          <th>Catalog</th>
                          <th>Item / Line Count</th>
                          <th>Subtotal</th>
                          <th>Submitted At</th>
                          <th>Shopify Admin</th>
                        </tr>
                      </thead>
                      <tbody>
                        {submissions.map((sub) => (
                          <tr key={sub.id}>
                            <td>
                              <strong>{sub.draftOrderName || 'Draft Order'}</strong>
                            </td>
                            <td>{sub.catalogName}</td>
                            <td>
                              {sub.itemCount} units ({sub.lineCount} SKUs)
                            </td>
                            <td>
                              <strong>{sub.formattedSubtotal}</strong>
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
                                  View in Shopify ↗
                                </a>
                              ) : (
                                <span className="cf-text-muted">N/A</span>
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
                    <h3>Inventory & Catalog Mirror Health</h3>
                    <p className="cf-section-desc">
                      CatalogFlow maintains live synchronization with Shopify via webhooks and scheduled sync runs.
                    </p>
                  </div>
                  <button
                    className="cf-btn cf-btn-primary"
                    onClick={handleManualSync}
                    disabled={syncing}
                  >
                    {syncing ? 'Syncing...' : '🔄 Run Full Reconcile Now'}
                  </button>
                </div>

                <div className="cf-summary-grid">
                  <div className="cf-summary-box">
                    <span className="cf-summary-label">Sync Health</span>
                    <span className="cf-summary-value">
                      {syncHealth?.sync.status === 'COMPLETED' ? '🟢 Healthy' : '🟡 In Progress'}
                    </span>
                    <span className="cf-summary-hint">
                      Last synchronized: {syncHealth?.sync.lastSyncAt ? new Date(syncHealth.sync.lastSyncAt).toLocaleString() : 'Pending'}
                    </span>
                  </div>

                  <div className="cf-summary-box">
                    <span className="cf-summary-label">Products Mirrored</span>
                    <span className="cf-summary-value">{syncHealth?.inventory.productsCount || 0}</span>
                    <span className="cf-summary-hint">
                      Variants: {syncHealth?.inventory.variantsCount || 0}
                    </span>
                  </div>

                  <div className="cf-summary-box">
                    <span className="cf-summary-label">Collections Mirrored</span>
                    <span className="cf-summary-value">{syncHealth?.inventory.collectionsCount || 0}</span>
                    <span className="cf-summary-hint">Active collections in store</span>
                  </div>

                  <div className="cf-summary-box">
                    <span className="cf-summary-label">Security & Architecture</span>
                    <span className="cf-summary-value">Zero Raw PII</span>
                    <span className="cf-summary-hint">Live GraphQL Draft Order pipeline</span>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </main>

      {/* Create Catalog Modal */}
      {showCreateModal && (
        <div className="cf-modal-overlay">
          <div className="cf-modal">
            <div className="cf-modal-header">
              <h3>Create Wholesale Catalog</h3>
              <button
                type="button"
                className="cf-close-btn"
                onClick={() => setShowCreateModal(false)}
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleCreateCatalog}>
              <div className="cf-modal-body">
                <div className="cf-form-group">
                  <label>Catalog Name *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. VIP Wholesale 2026"
                    value={newCatalogName}
                    onChange={(e) => setNewCatalogName(e.target.value)}
                    className="cf-input"
                  />
                </div>

                <div className="cf-form-group">
                  <label>Pricing Rule</label>
                  <select
                    value={newPriceMode}
                    onChange={(e: any) => setNewPriceMode(e.target.value)}
                    className="cf-select"
                  >
                    <option value="SHOPIFY_PRICE">Shopify Retail Price (No discount)</option>
                    <option value="PERCENT_DISCOUNT">Percentage Wholesale Discount</option>
                  </select>
                </div>

                {newPriceMode === 'PERCENT_DISCOUNT' && (
                  <div className="cf-form-group">
                    <label>Discount Percentage (%)</label>
                    <input
                      type="number"
                      min="1"
                      max="90"
                      value={newDiscount}
                      onChange={(e) => setNewDiscount(Number(e.target.value))}
                      className="cf-input"
                    />
                  </div>
                )}

                <div className="cf-form-group">
                  <label>Accent Color</label>
                  <input
                    type="color"
                    value={newAccentColor}
                    onChange={(e) => setNewAccentColor(e.target.value)}
                    className="cf-color-input"
                  />
                </div>

                <div className="cf-form-group">
                  <label>Product Source</label>
                  <div className="cf-radio-group">
                    <label>
                      <input
                        type="radio"
                        name="sourceType"
                        value="COLLECTION"
                        checked={newSourceType === 'COLLECTION'}
                        onChange={() => setNewSourceType('COLLECTION')}
                      />
                      Collection (Recommended)
                    </label>
                  </div>
                </div>

                <div className="cf-form-group">
                  <label>Collection GID (Optional)</label>
                  <input
                    type="text"
                    placeholder="gid://shopify/Collection/... (or leave blank for all)"
                    value={newSourceGid}
                    onChange={(e) => setNewSourceGid(e.target.value)}
                    className="cf-input"
                  />
                </div>
              </div>

              <div className="cf-modal-footer">
                <button
                  type="button"
                  className="cf-btn cf-btn-secondary"
                  onClick={() => setShowCreateModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="cf-btn cf-btn-primary"
                  disabled={creatingCatalog}
                >
                  {creatingCatalog ? 'Creating...' : 'Create Catalog'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
