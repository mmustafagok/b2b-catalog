/**
 * Sanitizes user input intended for Shopify GraphQL query arguments (e.g. products(query: ...)).
 *
 * Shopify search uses Lucene-style syntax; unescaped chars like '"', ':', '(', ')'
 * can break query parsing and produce syntax errors.
 * This function hardens search queries by stripping Lucene control characters
 * while preserving alphanumeric terms, spaces, and hyphens.
 */
export function sanitizeShopifySearchQuery(raw: string): string {
  return raw.replace(/["|'\\:()[\]{}^~?!/*<>]/g, ' ').replace(/\s+/g, ' ').trim();
}
