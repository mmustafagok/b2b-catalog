import React, { useState, useEffect, useCallback } from 'react';
import './merchant.css';

interface ShopInfo {
  id: string;
  shopDomain: string;
  plan: string;
  initialSyncAt: string | null;
  installed: boolean;
}

export const MerchantAppShell: React.FC = () => {
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [shop, setShop] = useState<ShopInfo | null>(null);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);

  const bootstrapApp = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      // App Bridge script on Shopify Admin automatically intercepts fetch and attaches Authorization: Bearer <id_token>
      let headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      // If window.shopify is initialized, we can also explicitly acquire an ID token if needed
      if (typeof window !== 'undefined' && (window as any).shopify?.idToken) {
        try {
          const token = await (window as any).shopify.idToken();
          if (token) {
            headers['Authorization'] = `Bearer ${token}`;
          }
        } catch {
          // Fallback to App Bridge automatic fetch interceptor
        }
      }

      const response = await fetch('/api/admin/bootstrap', {
        method: 'POST',
        headers,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status} ${response.statusText}` }));
        throw new Error(errorData.error || `Server returned ${response.status}`);
      }

      const data = await response.json();
      if (data.success && data.shop) {
        setShop(data.shop);
        if (!data.shop.initialSyncAt) {
          setSyncNotice('Initial catalog sync has been triggered in the background.');
        }
      } else {
        throw new Error('Bootstrap returned unexpected payload format.');
      }
    } catch (err: any) {
      console.error('[CatalogFlow Embedded Shell] Bootstrap failed:', err);
      setError(err.message || 'Failed to authenticate and initialize embedded admin.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    bootstrapApp();
  }, [bootstrapApp]);

  return (
    <div className="cf-merchant-container">
      <header className="cf-merchant-header">
        <div className="cf-merchant-brand">
          <div className="cf-logo-icon">CF</div>
          <div>
            <h1 className="cf-merchant-title">CatalogFlow</h1>
            <p className="cf-merchant-subtitle">B2B Catalog & Wholesale Order Portal</p>
          </div>
        </div>
        <div className="cf-badge-container">
          <span className="cf-badge cf-badge-outline">Shopify Embedded Admin</span>
        </div>
      </header>

      <main className="cf-merchant-main">
        {loading && (
          <div className="cf-card cf-state-card">
            <div className="cf-spinner"></div>
            <h2 className="cf-state-title">Verifying Shopify Identity & Session</h2>
            <p className="cf-state-desc">
              Establishing secure App Bridge communication, rotating offline credentials, and verifying shop installation...
            </p>
          </div>
        )}

        {error && !loading && (
          <div className="cf-card cf-state-card cf-error-card">
            <div className="cf-error-icon">⚠️</div>
            <h2 className="cf-state-title">Authentication / Bootstrap Error</h2>
            <p className="cf-state-desc">{error}</p>
            <button
              id="cf-retry-btn"
              type="button"
              className="cf-btn cf-btn-primary"
              onClick={bootstrapApp}
            >
              Retry Connection
            </button>
          </div>
        )}

        {shop && !loading && (
          <div className="cf-card cf-dashboard-card">
            <div className="cf-shop-status-banner">
              <div className="cf-status-indicator">
                <span className="cf-status-dot"></span>
                <strong>Shop Connected:</strong> {shop.shopDomain}
              </div>
              <div className="cf-badges">
                <span className="cf-badge cf-badge-success">Active</span>
                <span className="cf-badge cf-badge-info">Plan: {shop.plan}</span>
              </div>
            </div>

            {syncNotice && (
              <div className="cf-alert cf-alert-info">
                ℹ️ {syncNotice} Products and collections are being mirrored to your local catalog.
              </div>
            )}

            <div className="cf-summary-grid">
              <div className="cf-summary-box">
                <span className="cf-summary-label">Authentication Mode</span>
                <span className="cf-summary-value">Token Exchange (RFC 8693)</span>
                <span className="cf-summary-hint">Expiring Offline Access Token + Rotation</span>
              </div>
              <div className="cf-summary-box">
                <span className="cf-summary-label">Sync Status</span>
                <span className="cf-summary-value">
                  {shop.initialSyncAt ? 'Initialized' : 'Syncing in background'}
                </span>
                <span className="cf-summary-hint">
                  {shop.initialSyncAt
                    ? `Last completed: ${new Date(shop.initialSyncAt).toLocaleTimeString()}`
                    : 'Awaiting sync completion'}
                </span>
              </div>
              <div className="cf-summary-box">
                <span className="cf-summary-label">Credential Security</span>
                <span className="cf-summary-value">AES-256-GCM Encrypted</span>
                <span className="cf-summary-hint">Zero browser credential exposure</span>
              </div>
            </div>

            <div className="cf-next-steps">
              <p className="cf-hint-text">
                Embedded admin bootstrap verified successfully. Catalogs and wholesale order links will appear here.
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};
