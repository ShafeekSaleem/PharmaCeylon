import type { CategoryTreeNode } from "@/components/ui";

export type MatchType = "exact" | "generic" | "alias" | "partial";
export type StockStatus = "healthy" | "low" | "out";

export type CatalogRef = { id: string; name: string };

export type CatalogSearchItem = {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  brandName: string | null;
  genericName: string | null;
  dosageForm: string | null;
  strength: string | null;
  unit: string | null;
  imageUrl: string | null;
  registrationNo: string | null;
  schedule: string | null;
  isControlled: boolean;
  isActive: boolean;
  reorderLevel: number;
  qtyOnHand: number | null;
  stockStatus: StockStatus | null;
  sellPrice: number | null;
  matchType: MatchType;
  matchField: string;
  categories: CatalogRef[];
  tags: CatalogRef[];
};

export type CatalogSearchResponse = {
  items: CatalogSearchItem[];
  total: number;
  skip: number;
  take: number;
  exactCount: number;
  aliasCount: number;
  genericCount: number;
  truncated?: boolean;
  hasMore?: boolean;
};

export type CatalogFacets = {
  brands: Array<{ value: string; count: number }>;
  dosageForms: Array<{ value: string; count: number }>;
  categories: Array<{ value: string; label: string; count: number }>;
  /** Active COMMERCIAL department → category tree — this is the "Category" filter. */
  commercialDepartments?: CategoryTreeNode[];
  tags: Array<{ value: string; label: string; count: number }>;
  controlled: Array<{ value: boolean; count: number }>;
  branchStockSummary: {
    inStockProductCount: number;
    lowStockProductCount: number;
    outOfStockProductCount: number;
  } | null;
};

export type CatalogBranchAvailability = {
  branchId: string;
  code: string;
  name: string;
  qtyOnHand: number;
  stockStatus: StockStatus;
  isActiveBranch: boolean;
};

export type CatalogProductDetail = {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  brandName: string | null;
  genericName: string | null;
  manufacturer: string | null;
  dosageForm: string | null;
  strength: string | null;
  unit: string | null;
  packSize: string | null;
  packType: string | null;
  imageUrl: string | null;
  registrationNo: string | null;
  registrationDate: string | null;
  schedule: string | null;
  regType: string | null;
  dossierNo: string | null;
  countryOfOrigin: string | null;
  localAgent: string | null;
  isControlled: boolean;
  requiresPrescription: boolean;
  isActive: boolean;
  reorderLevel: number;
  aliases: string[];
  categories: CatalogRef[];
  tags: CatalogRef[];
  qtyOnHand: number | null;
  stockStatus: StockStatus | null;
  sellPrice: number | null;
  costPrice: number | null;
  branchAvailability: CatalogBranchAvailability[];
};

export type CatalogAlternative = {
  product: {
    id: string;
    sku: string;
    name: string;
    brandName: string | null;
    genericName: string | null;
    dosageForm: string | null;
    strength: string | null;
    imageUrl: string | null;
    reorderLevel: number;
  };
  reason: string;
  score: number | null;
  qtyOnHand: number | null;
  stockStatus: StockStatus | null;
};

export type CatalogFilters = {
  q: string;
  exact: boolean;
  inStock: boolean;
  controlled: boolean;
  dosageForm: string;
  brandName: string;
  /** Commercial (merchandising) Category filter — one or more department/category ids. */
  commercialCategoryIds: string[];
  tagId: string;
  stockStatus: "" | "in" | "low" | "out";
};

export const DEFAULT_FILTERS: CatalogFilters = {
  q: "",
  exact: false,
  inStock: false,
  controlled: false,
  dosageForm: "",
  brandName: "",
  commercialCategoryIds: [],
  tagId: "",
  stockStatus: "",
};

export const RECENT_SEARCHES_KEY = "pc.catalog.recentSearches";
export const RECENT_VIEWS_KEY = "pc.catalog.recentViews";
export const MAX_RECENT = 8;
export const MAX_RECENT_VIEWS = 6;

export type RecentView = { id: string; name: string };
