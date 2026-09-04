export type CommercialCategoryNode = {
  id: string;
  name: string;
  canonicalKey: string | null;
  source: string;
  isSystem: boolean;
  isActive: boolean;
  sortOrder: number;
  /** Products the pharmacy sells that are filed here — the headline number. */
  rangedCount: number;
  /** Reference-catalog rows filed here. Context beside it, never the headline. */
  referenceCount: number;
  /** Both together — what the disable warning and delete guard read. */
  productCount: number;
  children: CommercialCategoryNode[];
};

export type OnboardingGroupStatus = { label: string; enabled: boolean };
