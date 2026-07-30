import type { SortDir } from "@/components/ui";

export type ProductCategory = {
  id: string;
  name: string;
  parentCategoryId: string | null;
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

export type Product = {
  id: string;
  tenantId: string;
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
  storage: string | null;
  shelfLife: string | null;
  taxCategory: string | null;
  imageUrl: string | null;
  isControlled: boolean;
  reorderLevel: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  categories?: ProductCategory[];
  tags?: ProductTag[];
  aliases?: ProductAlias[];
  qtyOnHand?: number | null;
  stockStatus?: StockStatus | null;
  reorderGap?: number | null;
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

export type SummaryFacets = {
  brands: FacetEntry[];
  dosageForms: FacetEntry[];
  categories?: FacetEntry[];
  tags?: FacetEntry[];
  controlled: { value: boolean; count: number }[];
  status?: FacetEntry[];
  branchStockSummary: {
    inStockProductCount: number;
    lowStockProductCount: number;
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
  storage: string;
  shelfLife: string;
  taxCategory: string;
  imageUrl: string | null;
  reorderLevel: number;
  isControlled: boolean;
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
  | "stock"
  | "reorderLevel"
  | "status"
  | "actions";

export type StatFilter = "all" | "active" | "inactive" | "controlled" | "lowStock";
