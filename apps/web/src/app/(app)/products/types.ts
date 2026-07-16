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
  batches: ProductBatch[];
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

export type StatFilter = "all" | "active" | "controlled" | "lowStock";
