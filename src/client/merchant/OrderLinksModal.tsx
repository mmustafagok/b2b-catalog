import React, { useState, useEffect } from 'react';
import { authenticatedFetch } from './appBridgeAuth.js';
import { CatalogSummary } from './EditCatalogModal.js';

interface OrderLink {
  id: string;
  token: string;
  label: string;
  active: boolean;
  passcodeHash: string | null;
  expiresAt: string | null;
  source: string | null;
  views: number;
  submissions: number;
  submittedValue: string | number;
  createdAt: string;
}

interface OrderLinksModalProps {
  catalog: CatalogSummary;
  onClose: () => void;
  onToast: (msg: string) => void;
}

export const OrderLinksModal: React.FC<OrderLinksModalProps> = ({
  catalog,
  onClose,
  onToast,
}) => {
  const [links, setLinks] = useState<OrderLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);

  // New Link form state
  const [label, setLabel] = useState('');
  const [passcode, setPasscode] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [source, setSource] = useState('');

  // QR Code preview modal
  const [qrModalData, setQrModalData] = useState<{ qrDataUrl: string; buyerUrl: string; label: string } | null>(null);

  const fetchLinks = async () => {
    try {
      setLoading(true);
      const res = await authenticatedFetch(`/api/admin/catalogs/${catalog.id}/links`);
      if (res.ok) {
        const data = await res.json();
        setLinks(data.links || []);
      }
    } catch (err: any) {
      onToast(`Error loading links: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLinks();
  }, [catalog.id]);

  const handleCreateLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim() || creating) return;

    try {
      setCreating(true);
      const res = await authenticatedFetch(`/api/admin/catalogs/${catalog.id}/links`, {
        method: 'POST',
        body: JSON.stringify({
          label: label.trim(),
          passcode: passcode.trim() || undefined,
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
          source: source.trim() || undefined,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to create order link');
      }

      onToast('Wholesale link created successfully!');
      setLabel('');
      setPasscode('');
      setExpiresAt('');
      setSource('');
      setShowCreateForm(false);
      fetchLinks();
    } catch (err: any) {
      onToast(`Error: ${err.message}`);
    } finally {
      setCreating(false);
    }
  };

  const handleToggleActive = async (link: OrderLink) => {
    try {
      const res = await authenticatedFetch(`/api/admin/catalogs/${catalog.id}/links/${link.id}`, {
        method: 'PUT',
        body: JSON.stringify({ active: !link.active }),
      });
      if (res.ok) {
        onToast(`Link ${link.active ? 'deactivated' : 'activated'}`);
        fetchLinks();
      }
    } catch (err: any) {
      onToast(`Error: ${err.message}`);
    }
  };

  const handleCopyLink = (token: string) => {
    const url = `${window.location.origin}/l/${token}`;
    navigator.clipboard.writeText(url);
    onToast('Order link copied to clipboard!');
  };

  const handleShowQr = async (link: OrderLink) => {
    try {
      const res = await authenticatedFetch(`/api/admin/catalogs/${catalog.id}/links/${link.id}/qr`);
      if (res.ok) {
        const data = await res.json();
        setQrModalData({ qrDataUrl: data.qrDataUrl, buyerUrl: data.buyerUrl, label: link.label });
      }
    } catch (err: any) {
      onToast(`Error fetching QR code: ${err.message}`);
    }
  };

  return (
    <div className="cf-modal-backdrop" onClick={onClose}>
      <div className="cf-modal cf-modal-lg" onClick={(e) => e.stopPropagation()}>
        <div className="cf-modal-header">
          <div>
            <h3>Wholesale Order Links: {catalog.name}</h3>
            <p style={{ fontSize: '0.825rem', color: '#64748b' }}>
              Create targeted links with optional passcodes, expiration dates, and conversion tracking.
            </p>
          </div>
          <button type="button" className="cf-modal-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="cf-modal-body" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>Active Links ({links.length})</span>
            <button
              type="button"
              className="cf-btn cf-btn-sm cf-btn-primary"
              onClick={() => setShowCreateForm(!showCreateForm)}
            >
              {showCreateForm ? 'Cancel' : '+ New Order Link'}
            </button>
          </div>

          {/* Create Link Form */}
          {showCreateForm && (
            <form onSubmit={handleCreateLink} style={{ background: '#f8fafc', padding: '1rem', borderRadius: '8px', border: '1px solid #e2e8f0', marginBottom: '1.25rem' }}>
              <h4 style={{ fontSize: '0.9rem', marginBottom: '0.75rem', fontWeight: 600 }}>Create New Order Link</h4>
              
              <div className="cf-form-group">
                <label className="cf-label" htmlFor="link-label">Link Label / Buyer Tag *</label>
                <input
                  id="link-label"
                  type="text"
                  placeholder="e.g. VIP Wholesale Accounts or Fall Trade Show"
                  className="cf-input"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  required
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                <div className="cf-form-group">
                  <label className="cf-label" htmlFor="link-passcode">Access Passcode (Optional)</label>
                  <input
                    id="link-passcode"
                    type="text"
                    placeholder="Leave empty for open access"
                    className="cf-input"
                    value={passcode}
                    onChange={(e) => setPasscode(e.target.value)}
                  />
                </div>

                <div className="cf-form-group">
                  <label className="cf-label" htmlFor="link-expiry">Expires On (Optional)</label>
                  <input
                    id="link-expiry"
                    type="date"
                    className="cf-input"
                    value={expiresAt}
                    onChange={(e) => setExpiresAt(e.target.value)}
                  />
                </div>
              </div>

              <div className="cf-form-group">
                <label className="cf-label" htmlFor="link-source">Channel / Attribution Source (Optional)</label>
                <input
                  id="link-source"
                  type="text"
                  placeholder="e.g. email_campaign or tradeshow_booth"
                  className="cf-input"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
                <button type="button" className="cf-btn cf-btn-secondary" onClick={() => setShowCreateForm(false)}>
                  Cancel
                </button>
                <button type="submit" className="cf-btn cf-btn-primary" disabled={creating || !label.trim()}>
                  {creating ? 'Creating...' : 'Create Link'}
                </button>
              </div>
            </form>
          )}

          {/* Links List Table */}
          {loading ? (
            <p style={{ textAlign: 'center', padding: '1rem', color: '#64748b' }}>Loading links...</p>
          ) : links.length === 0 ? (
            <p style={{ textAlign: 'center', padding: '1.5rem', color: '#64748b' }}>No custom links created yet.</p>
          ) : (
            <div className="cf-table-container">
              <table className="cf-table" style={{ fontSize: '0.85rem' }}>
                <thead>
                  <tr>
                    <th>Label / Source</th>
                    <th>Security</th>
                    <th>Views</th>
                    <th>Orders</th>
                    <th>GMV</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {links.map((link) => {
                    const isExpired = link.expiresAt && new Date(link.expiresAt) < new Date();
                    return (
                      <tr key={link.id}>
                        <td>
                          <strong>{link.label}</strong>
                          {link.source && <div style={{ fontSize: '0.75rem', color: '#64748b' }}>Source: {link.source}</div>}
                        </td>
                        <td>
                          {link.passcodeHash ? (
                            <span className="cf-badge cf-badge-warning">🔒 Passcode</span>
                          ) : (
                            <span className="cf-badge cf-badge-outline">Public</span>
                          )}
                          {link.expiresAt && (
                            <div style={{ fontSize: '0.75rem', color: isExpired ? '#dc2626' : '#64748b' }}>
                              {isExpired ? 'Expired' : `Exp: ${new Date(link.expiresAt).toLocaleDateString()}`}
                            </div>
                          )}
                        </td>
                        <td>{link.views}</td>
                        <td>{link.submissions}</td>
                        <td>${Number(link.submittedValue || 0).toFixed(2)}</td>
                        <td>
                          <span className={`cf-badge ${link.active && !isExpired ? 'cf-badge-success' : 'cf-badge-outline'}`}>
                            {isExpired ? 'Expired' : link.active ? 'Active' : 'Inactive'}
                          </span>
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: '0.3rem' }}>
                            <button
                              type="button"
                              className="cf-btn cf-btn-sm cf-btn-secondary"
                              onClick={() => handleCopyLink(link.token)}
                              title="Copy buyer link"
                            >
                              📋
                            </button>
                            <button
                              type="button"
                              className="cf-btn cf-btn-sm cf-btn-secondary"
                              onClick={() => handleShowQr(link)}
                              title="Show QR code"
                            >
                              📱 QR
                            </button>
                            <button
                              type="button"
                              className="cf-btn cf-btn-sm cf-btn-outline"
                              onClick={() => handleToggleActive(link)}
                            >
                              {link.active ? 'Disable' : 'Enable'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="cf-modal-footer">
          <button type="button" className="cf-btn cf-btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      {/* QR Code Popup */}
      {qrModalData && (
        <div className="cf-modal-backdrop" style={{ zIndex: 1100 }} onClick={() => setQrModalData(null)}>
          <div className="cf-modal" style={{ maxWidth: '380px', textAlign: 'center', padding: '1.5rem' }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontSize: '1.1rem', marginBottom: '0.5rem' }}>{qrModalData.label}</h3>
            <p style={{ fontSize: '0.825rem', color: '#64748b', marginBottom: '1rem' }}>
              Scan with camera to open wholesale catalog
            </p>
            <img src={qrModalData.qrDataUrl} alt="QR Code" style={{ width: '220px', height: '220px', margin: '0 auto', display: 'block', border: '1px solid #e2e8f0', borderRadius: '8px' }} />
            <div style={{ marginTop: '1.25rem', display: 'flex', gap: '0.5rem', justifyContent: 'center' }}>
              <a
                href={qrModalData.qrDataUrl}
                download={`qr-${qrModalData.label.toLowerCase().replace(/\s+/g, '-')}.png`}
                className="cf-btn cf-btn-primary cf-btn-sm"
              >
                💾 Download PNG
              </a>
              <button
                type="button"
                className="cf-btn cf-btn-secondary cf-btn-sm"
                onClick={() => setQrModalData(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
