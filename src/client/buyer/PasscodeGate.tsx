import React, { useState } from 'react';

interface PasscodeGateProps {
  catalogName?: string;
  linkLabel?: string;
  onSubmitPasscode: (passcode: string) => Promise<void>;
  error?: string | null;
  loading?: boolean;
}

export const PasscodeGate: React.FC<PasscodeGateProps> = ({
  catalogName = 'Wholesale Catalog',
  linkLabel,
  onSubmitPasscode,
  error,
  loading = false,
}) => {
  const [passcode, setPasscode] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passcode.trim() || loading) return;
    await onSubmitPasscode(passcode.trim());
  };

  return (
    <div className="passcode-gate-container">
      <div className="passcode-card">
        <div className="passcode-lock-icon">🔒</div>
        <h2 className="passcode-title">{catalogName}</h2>
        {linkLabel && <p className="passcode-subtitle">{linkLabel}</p>}
        <p className="passcode-instructions">
          This wholesale catalog is protected. Please enter the access passcode provided by your supplier.
        </p>

        <form onSubmit={handleSubmit} className="passcode-form">
          <div className="form-group">
            <label htmlFor="passcodeInput" className="form-label">
              Passcode
            </label>
            <input
              id="passcodeInput"
              type="password"
              className="passcode-input"
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              placeholder="Enter passcode"
              autoFocus
              disabled={loading}
              required
            />
          </div>

          {error && <div className="passcode-error">{error}</div>}

          <button
            type="submit"
            className="passcode-submit-btn"
            disabled={!passcode.trim() || loading}
          >
            {loading ? 'Verifying...' : 'Access Catalog'}
          </button>
        </form>
      </div>
    </div>
  );
};
