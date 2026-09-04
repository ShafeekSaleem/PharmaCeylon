import type { SortDir } from "@/components/ui";

export type ProductCategory = {
  id: string;
  name: string;
  parentCategoryId: string | null;
  /** Stable SaaS-level key for seeded categories, e.g. "MEDICINES". Null for tenant-created ones. */
  canonicalKey?: string | null;
  /** Departments a tenant hasn't opted into stay inactive rather than being deleted. */
  isActive?: boolean;
  productCount?: number;
};

export type ProductTag = {
  id: string;
  name: string;
  productCount?: number;
};

export type ProductAlias = {
  id: string;
  aliasText: string;
  aliasType: string;
};

export type TenantProductAlias = ProductAlias & {
  productId: string;
  product: { id: string; sku: string; name: string };
};

export type StockStatus = "out" | "low" | "ok";

/**
 * Does this pharmacy sell the product?
 *
 * REFERENCE — an imported registry record, searchable in Search Catalog but kept out of the
 * shop's own product list and out of transaction pickers.
 * RANGED — part of what the pharmacy stocks and sells.
 *
 * Separate from `isActive`, which is the pharmacist-owned "is this record enabled" flag:
 * a RANGED product that is inactive is a discontinued line.
 */
export type ProductRangeStatus = "REFERENCE" | "RANGED";

/** Catalog record origin. NMRA-specific fields only apply when source = NMRA. */
export type CatalogSource = "NMRA" | "MANUAL" | "SUPPLIER" | "CSV_IMPORT" | "BARCODE";

export type Product = {
  id: string;
  tenantId: string;
  sku: string;
  source: CatalogSource;
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
  storage: string | null;
  shelfLife: string | null;
  taxCategory: string | null;
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
  reorderLevel: number;
  isActive: boolean;
  rangeStatus: ProductRangeStatus;
  /** When the product joined the pharmacy's range. Null while REFERENCE. */
  rangedAt: string | null;
  /** NMRA registration currency — import-owned, only set for source = NMRA. */
  nmraRegistrationValid?: boolean | null;
  createdAt: string;
  updatedAt: string;
  categories?: ProductCategory[];
  tags?: ProductTag[];
  aliases?: ProductAlias[];
  qtyOnHand?: number | null;
  stockStatus?: StockStatus | null;
  reorderGap?: number | null;
  /** Count of products sharing this display name (multi-registration groups). */
  sameNameCount?: number;
};

export type ProductList = { items: Product[]; total: number; skip: number; take: number };

export type ProductBatch = {
  id: string;
  batchNo: string;
  expiryDate: string;
  costPrice: string;
  sellingPrice: string;
  receivedAt: string;
  qtyOnHand: number;
  daysToExpiry: number;
  nearExpiry: boolean;
  expired: boolean;
  fefoPriority: number;
};

export type ProductBranchStockRow = {
  branchId: string;
  branchName: string;
  qtyOnHand: number;
  availableQty: number;
  reservedQty: number;
  reorderLevel: number;
  stockStatus: StockStatus;
  lastMovementAt: string | null;
  lastMovementType: string | null;
  isCurrentBranch: boolean;
};

export type ProductStockMovement = {
  id: string;
  occurredAt: string;
  movementType: string;
  referenceType: string;
  referenceId: string;
  reason?: string | null;
  batchNo: string | null;
  qtyDelta: number;
  balanceBefore: number;
  balanceAfter: number;
  actorName: string | null;
};

export type ProductBranchSummary = {
  branchId: string;
  branchName: string;
  lastMovementAt: string | null;
  nextExpiryBatchNo: string | null;
  nextExpiryDate: string | null;
  nextExpiryDays: number | null;
  nearExpiryBatchCount: number;
  primarySellingPrice: string | null;
  primaryCostPrice: string | null;
  marginPercent: number | null;
  avgMonthlyUsage?: number | null;
};

export type ProductPricing = {
  minSellingPrice: string | null;
  maxSellingPrice: string | null;
  minCostPrice: string | null;
  maxCostPrice: string | null;
  batchCount: number;
};

export type ProductDetailTab = "overview" | "stock" | "pricing" | "history";

export type AuditHistoryItem = {
  id: string;
  eventName: string;
  createdAt: string;
  payload: unknown;
  actor: { id: string; fullName: string; email: string } | null;
};

export type ProductDetail = {
  product: Product;
  qtyOnHand: number | null;
  stockStatus: StockStatus | null;
  reorderGap: number | null;
  branchName: string | null;
  batches: ProductBatch[];
  branchStock: ProductBranchStockRow[];
  movements: ProductStockMovement[];
  branchSummary: ProductBranchSummary | null;
  pricing: ProductPricing;
  history: AuditHistoryItem[];
};

export type FacetEntry = { value: string; count: number; label?: string };

export type CommercialCategoryNode = {
  id: string;
  label: string;
  canonicalKey: string | null;
  count: number;
  children?: CommercialCategoryNode[];
};

export type SummaryFacets = {
  brands: FacetEntry[];
  dosageForms: FacetEntry[];
  schedules?: FacetEntry[];
  formGroups?: FacetEntry[];
  registrationTypes?: FacetEntry[];
  categories?: FacetEntry[];
  commercialDepartments?: CommercialCategoryNode[];
  tags?: FacetEntry[];
  controlled: { value: boolean; count: number }[];
  status?: FacetEntry[];
  /** Drives the "My products" / "Reference catalog" tab counts. */
  rangeStatus?: FacetEntry[];
  requiresPrescription?: { value: boolean; count: number }[];
  branchStockSummary: {
    inStockProductCount: number;
    lowStockProductCount: number;
    outOfStockProductCount?: number;
  } | null;
};

export type ProductForm = {
  sku: string;
  barcode: string;
  name: string;
  genericName: string;
  brandName: string;
  manufacturer: string;
  dosageForm: string;
  strength: string;
  unit: string;
  packSize: string;
  packType: string;
  storage: string;
  shelfLife: string;
  taxCategory: string;
  registrationNo: string;
  registrationDate: string;
  schedule: string;
  regType: string;
  dossierNo: string;
  countryOfOrigin: string;
  localAgent: string;
  imageUrl: string | null;
  reorderLevel: number;
  isControlled: boolean;
  requiresPrescription: boolean;
  isActive: boolean;
  categoryIds: string[];
  tagIds: string[];
};

export type ColumnKey =
  | "image"
  | "sku"
  | "name"
  | "brandName"
  | "dosageForm"
  | "manufacturer"
  | "unit"
  | "registrationNo"
  | "schedule"
  | "stock"
  | "reorderLevel"
  | "status"
  | "actions";

export type StatFilter =
  | "all"
  | "active"
  | "inactive"
  | "controlled"
  | "lowStock"
  | "rx";

/** Products page tab: the shop's own range, or the imported reference catalog. */
export type ProductScope = "mine" | "reference";

export type BulkProductAction =
  | "range"
  | "unrange"
  | "activate"
  | "deactivate"
  | "set_category"
  | "clear_category"
  | "add_tags"
  | "remove_tags";

export type BulkProductResult = {
  matched: number;
  updated: number;
  action: BulkProductAction;
};

/** Mirrors `BulkProductPreview` in apps/api/src/products/products.service.ts. */
export type BulkProductPreview = {
  action: BulkProductAction;
  matched: number;
  willChange: number;
  alreadyOnTarget: number;
  replacingExisting: number;
  replacingManual: number;
  categoryName: string | null;
  tagNames: string[];
};
