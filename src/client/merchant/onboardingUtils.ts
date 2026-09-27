export interface OnboardingState {
  hasCatalog: boolean;
  hasPublished: boolean;
  linkShared: boolean;
  hasFirstOrder: boolean;
  isActivated: boolean;
  shouldShowFirstUseCard: boolean;
  shouldShowChecklist: boolean;
}

export function deriveOnboardingState(params: {
  catalogsCount: number;
  publishedCatalogsCount: number;
  linkShared: boolean;
  submissionsCount: number;
}): OnboardingState {
  const hasCatalog = params.catalogsCount > 0;
  const hasPublished = params.publishedCatalogsCount > 0;
  const linkShared = Boolean(params.linkShared);
  const hasFirstOrder = params.submissionsCount > 0;

  // Activated merchant = has received at least one real buyer order / submission
  const isActivated = hasFirstOrder;

  // First-use card shown on dashboard when merchant has no catalogs and no orders
  const shouldShowFirstUseCard = !hasCatalog && !isActivated;

  // Progress checklist shown on dashboard until merchant receives first order
  const shouldShowChecklist = !isActivated;

  return {
    hasCatalog,
    hasPublished,
    linkShared,
    hasFirstOrder,
    isActivated,
    shouldShowFirstUseCard,
    shouldShowChecklist,
  };
}

export function getLinkSharedStorageKey(shopId?: string): string {
  return `cf_link_shared_${shopId || 'default'}`;
}

export function isLinkSharedStored(shopId?: string): boolean {
  if (typeof window === 'undefined' || !window.localStorage) return false;
  try {
    return window.localStorage.getItem(getLinkSharedStorageKey(shopId)) === 'true';
  } catch {
    return false;
  }
}

export function setLinkSharedStored(shopId?: string): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(getLinkSharedStorageKey(shopId), 'true');
  } catch {
    // ignore storage quota / security errors
  }
}
