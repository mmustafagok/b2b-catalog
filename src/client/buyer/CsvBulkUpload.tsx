import React, { useState } from 'react';

interface CsvBulkUploadProps {
  token: string;
  isLinkRoute?: boolean;
  linkAccessToken?: string;
  onApplyLines: (lines: Array<{ variantId: string; quantity: number }>) => void;
  onClose: () => void;
}

interface ValidationResult {
  validLines: Array<{
    variantId: string;
    quantity: number;
    sku: string;
    productTitle: string;
    variantTitle: string;
  }>;
  errors: Array<{
    row: number;
    sku: string;
    qty: number | null;
    error: string;
    errorCode: string;
  }>;
  totalParsedRows: number;
}

export const CsvBulkUpload: React.FC<CsvBulkUploadProps> = ({
  token,
  isLinkRoute = false,
  linkAccessToken,
  onApplyLines,
  onClose,
}) => {
  const [csvText, setCsvText] = useState('');
  const [validating, setValidating] = useState(false);
  const [result, setResult] = useState<ValidationResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      const text = (evt.target?.result as string) || '';
      setCsvText(text);
      setResult(null);
      setErrorMsg(null);
    };
    reader.readAsText(file);
  };

  const handleValidate = async () => {
    if (!csvText.trim()) {
      setErrorMsg('Please paste CSV text or choose a CSV file.');
      return;
    }

    try {
      setValidating(true);
      setErrorMsg(null);

      const endpoint = isLinkRoute
        ? `/api/public/link/${token}/bulk-validate`
        : `/api/public/catalog/${token}/bulk-validate`;

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (linkAccessToken) {
        headers['X-Link-Access-Token'] = linkAccessToken;
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ csvText }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || 'Failed to validate CSV lines');
      }

      const json: ValidationResult = await res.json();
      setResult(json);
    } catch (err: any) {
      setErrorMsg(err.message || 'Error validating CSV');
    } finally {
      setValidating(false);
    }
  };

  const handleApply = () => {
    if (!result || result.validLines.length === 0) return;
    onApplyLines(result.validLines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })));
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="csv-bulk-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Bulk CSV Order Upload</h2>
          <button type="button" className="close-btn" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="csv-modal-body">
          <p className="csv-instruction">
            Upload or paste a CSV file with <code>SKU,Quantity</code> columns to quickly add items to your wholesale order.
          </p>

          <div className="csv-input-section">
            <div className="file-upload-row">
              <label className="file-upload-label">
                📂 Choose CSV File
                <input
                  type="file"
                  accept=".csv,.txt"
                  onChange={handleFileUpload}
                  style={{ display: 'none' }}
                />
              </label>
              <span className="file-hint">Or paste directly below</span>
            </div>

            <textarea
              className="csv-textarea"
              rows={6}
              placeholder={`SKU,Qty\nPROD-001-SM,10\nPROD-002-LG,25`}
              value={csvText}
              onChange={(e) => {
                setCsvText(e.target.value);
                setResult(null);
                setErrorMsg(null);
              }}
            />

            <button
              type="button"
              className="btn btn-primary validate-btn"
              disabled={validating || !csvText.trim()}
              onClick={handleValidate}
            >
              {validating ? 'Validating CSV...' : 'Validate CSV Rows'}
            </button>
          </div>

          {errorMsg && <div className="csv-error-banner">{errorMsg}</div>}

          {result && (
            <div className="csv-results-section">
              <div className="csv-results-summary">
                <span className="badge badge-success">
                  ✓ {result.validLines.length} Valid {result.validLines.length === 1 ? 'Line' : 'Lines'}
                </span>
                {result.errors.length > 0 && (
                  <span className="badge badge-danger">
                    ⚠ {result.errors.length} {result.errors.length === 1 ? 'Error' : 'Errors'}
                  </span>
                )}
              </div>

              {result.errors.length > 0 && (
                <div className="csv-error-table-wrap">
                  <h4 className="error-section-title">Row Errors</h4>
                  <table className="csv-table error-table">
                    <thead>
                      <tr>
                        <th>Row</th>
                        <th>SKU</th>
                        <th>Qty</th>
                        <th>Issue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.errors.map((err, idx) => (
                        <tr key={idx}>
                          <td>{err.row}</td>
                          <td><code>{err.sku || '—'}</code></td>
                          <td>{err.qty ?? '—'}</td>
                          <td className="text-danger">{err.error}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {result.validLines.length > 0 && (
                <div className="csv-valid-table-wrap">
                  <h4 className="valid-section-title">Valid Items Ready to Add</h4>
                  <table className="csv-table valid-table">
                    <thead>
                      <tr>
                        <th>Product</th>
                        <th>Variant</th>
                        <th>SKU</th>
                        <th style={{ textAlign: 'right' }}>Qty</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.validLines.map((line, idx) => (
                        <tr key={idx}>
                          <td>{line.productTitle}</td>
                          <td>{line.variantTitle}</td>
                          <td><code>{line.sku}</code></td>
                          <td style={{ textAlign: 'right', fontWeight: 600 }}>{line.quantity}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!result || result.validLines.length === 0}
            onClick={handleApply}
          >
            Add {result?.validLines.length || 0} Valid Items to Order
          </button>
        </div>
      </div>
    </div>
  );
};
