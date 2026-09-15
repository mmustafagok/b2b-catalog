/**
 * Browser session-backed idempotency key manager for Buyer Catalog Portal.
 *
 * Persists pending idempotency key in sessionStorage scoped to the public catalog token
 * and an order-intent fingerprint (variant line IDs + quantities).
 *
 * Invariants:
 * 1. Survives browser page refreshes and network retries for the same logical order intent.
 * 2. If the buyer changes lines/quantities or starts a new order, a fresh key is generated.
 * 3. Cleared upon confirmed order completion or "Place Another Order".
 * 4. Stored exclusively in sessionStorage (session lifetime, never indefinite localStorage).
 * 5. Contains ZERO raw buyer PII (email, notes, etc. are never stored in session storage).
 */

export interface OrderIntentLine {
  variantId: string;
  quantity: number;
}

export function computeOrderFingerprint(lines: OrderIntentLine[]): string {
  // Sort lines deterministically by variantId
  const sorted = [...lines]
    .filter((l) => l.quantity > 0)
    .sort((a, b) => a.variantId.localeCompare(b.variantId));
  return sorted.map((l) => `${l.variantId}:${l.quantity}`).join('|');
}

export function generateIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `order-${crypto.randomUUID()}`;
  }
  return `order-${Date.now()}-${Math.random().toString(36).substring(2, 11)}-${Math.random().toString(36).substring(2, 11)}`;
}

export function getOrCreateBuyerIdempotencyKey(
  publicToken: string,
  lines: OrderIntentLine[],
  customStorage?: Storage
): string {
  const storage = customStorage || (typeof window !== 'undefined' ? window.sessionStorage : undefined);
  if (!storage) {
    return generateIdempotencyKey();
  }

  const storageKey = `cf_buyer_idemp_${publicToken}`;
  const fingerprint = computeOrderFingerprint(lines);

  try {
    const stored = storage.getItem(storageKey);
    if (stored) {
      const parsed = JSON.parse(stored);
      // If fingerprint matches, reuse the existing pending idempotency key
      if (parsed.fingerprint === fingerprint && typeof parsed.key === 'string' && parsed.key.length > 0) {
        return parsed.key;
      }
    }
  } catch {
    // Ignore storage parse errors
  }

  const newKey = generateIdempotencyKey();
  try {
    storage.setItem(storageKey, JSON.stringify({ key: newKey, fingerprint }));
  } catch {
    // Ignore storage quota errors
  }
  return newKey;
}

export function clearBuyerIdempotencyKey(publicToken: string, customStorage?: Storage): void {
  const storage = customStorage || (typeof window !== 'undefined' ? window.sessionStorage : undefined);
  if (!storage) return;
  try {
    storage.removeItem(`cf_buyer_idemp_${publicToken}`);
  } catch {
    // Ignore storage errors
  }
}
