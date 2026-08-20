export type CommercialCategoryNode = {
  id: string;
  name: string;
  canonicalKey: string | null;
  source: string;
  isSystem: boolean;
  isActive: boolean;
  sortOrder: number;
  productCount: number;
  children: CommercialCategoryNode[];
};

export type OnboardingGroupStatus = { label: string; enabled: boolean };
