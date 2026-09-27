/**
 * Centralized, safe error normalization layer for public buyer-facing UI.
 * Guarantees [object Object] can NEVER be rendered to buyers.
 * Maps structured API errors (e.g. QTY_RULE_VIOLATION, INSUFFICIENT_INVENTORY)
 * to friendly buyer messages while safely hiding internal details/stack traces.
 */

export interface NormalizedBuyerError {
  message: string;
  code?: string;
  requestId?: string;
}

export function normalizeBuyerError(
  err: unknown,
  fallbackMessage = "We couldn't submit your order. Please review your quantities and try again."
): NormalizedBuyerError {
  if (!err) {
    return { message: fallbackMessage };
  }

  let code: string | undefined;
  let message: string | undefined;
  let requestId: string | undefined;
  let details: any;

  if (typeof err === 'string') {
    if (err.includes('[object Object]')) {
      return { message: fallbackMessage };
    }
    return { message: err };
  }

  if (typeof err === 'object') {
    const obj = err as Record<string, any>;

    // Handle nested { error: { code, message, details } } shape
    if (obj.error && typeof obj.error === 'object') {
      code = obj.error.code || obj.code;
      message = typeof obj.error.message === 'string' ? obj.error.message : undefined;
      details = obj.error.details || obj.details;
      requestId = obj.error.requestId || obj.requestId;
    } else if (typeof obj.error === 'string') {
      message = obj.error;
    }

    if (!code && obj.code && typeof obj.code === 'string') {
      code = obj.code;
    }
    if (!message && obj.message && typeof obj.message === 'string') {
      message = obj.message;
    }
    if (!requestId && obj.requestId && typeof obj.requestId === 'string') {
      requestId = obj.requestId;
    }
    if (!details && obj.details) {
      details = obj.details;
    }
  }

  // Guard against string "[object Object]"
  if (message && message.includes('[object Object]')) {
    message = undefined;
  }

  // Map known error codes to friendly buyer messages
  if (code === 'QTY_RULE_VIOLATION') {
    const violation = Array.isArray(details?.violations) ? details.violations[0] : (Array.isArray(details) ? details[0] : details);
    if (violation?.productTitle || violation?.variantTitle) {
      const item = `${violation.productTitle || 'Product'}${violation.variantTitle ? ` / ${violation.variantTitle}` : ''}`;
      const step = violation.step || violation.qtyIncrement || 1;
      const max = violation.max || violation.maxQty;
      return {
        message: `The quantity for ${item} isn't valid. Order in multiples of ${step}${max ? `, up to ${max}` : ''}.`,
        code,
        requestId,
      };
    }
    return {
      message: message || "Some quantities aren't valid. Please check pack/increment requirements.",
      code,
      requestId,
    };
  }

  if (code === 'INSUFFICIENT_INVENTORY' || code === 'INVENTORY_CHANGED') {
    const changed = Array.isArray(details?.variants) ? details.variants[0] : (Array.isArray(details?.items) ? details.items[0] : (Array.isArray(details) ? details[0] : null));
    if (changed) {
      let title = changed.productTitle || changed.title || 'An item';
      if (changed.variantTitle && changed.variantTitle !== 'Default Title') {
        title += ` (${changed.variantTitle})`;
      }
      const available = changed.available ?? 0;
      if (available > 0) {
        return {
          message: `Only ${available} unit${available === 1 ? '' : 's'} of ${title} are currently available. Please adjust the quantity.`,
          code,
          requestId,
        };
      }
      return {
        message: `${title} is no longer available in the requested quantity.`,
        code,
        requestId,
      };
    }
    return {
      message: message || "Some items in your cart have limited inventory. Please review quantities.",
      code,
      requestId,
    };
  }

  if (code === 'CATALOG_CHANGED') {
    return {
      message: "This catalog changed while you were ordering. Refresh the catalog and review your order before submitting.",
      code,
      requestId,
    };
  }

  if (code === 'OUT_OF_STOCK') {
    const changed = Array.isArray(details?.variants) ? details.variants[0] : (Array.isArray(details?.items) ? details.items[0] : (Array.isArray(details) ? details[0] : null));
    let title = changed?.productTitle || changed?.title || 'Selected item';
    if (changed?.variantTitle && changed.variantTitle !== 'Default Title') {
      title += ` (${changed.variantTitle})`;
    }
    return {
      message: `${title} is no longer available.`,
      code,
      requestId,
    };
  }

  if (code === 'LINK_EXPIRED') {
    return {
      message: "This wholesale order link has expired.",
      code,
      requestId,
    };
  }

  if (code === 'LINK_INACTIVE') {
    return {
      message: "This wholesale order link is no longer active.",
      code,
      requestId,
    };
  }

  if (code === 'QUOTA_EXCEEDED') {
    return {
      message: "This wholesale catalog is currently unable to accept new orders. Please contact the supplier directly.",
      code,
      requestId,
    };
  }

  if (code === 'BUYER_FORM_VALIDATION_FAILED' && message) {
    return {
      message,
      code,
      requestId,
    };
  }

  // Never leak internal stack traces, tokens, or raw database errors
  if (message && !message.includes('Prisma') && !message.includes('GraphQL') && !message.includes('SQL') && !message.includes('token') && !message.includes('secret')) {
    return {
      message,
      code,
      requestId,
    };
  }

  return {
    message: fallbackMessage,
    code,
    requestId,
  };
}
