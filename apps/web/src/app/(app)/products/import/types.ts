/** Mirrors `apps/api/src/product-import/product-import.types.ts`. */

export const IMPORT_FIELDS = [
  "name",
  "sku",
  "barcode",
  "brandName",
  "genericName",
  "manufacturer",
  "dosageForm",
  "strength",
  "unit",
  "packSize",
  "registrationNo",
  "categoryName",
  "reorderLevel",
  "qty",
  "costPrice",
  "sellingPrice",
  "batchNo",
  "expiryDate",
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];

export type ImportMapping = Partial<Record<ImportField, string>>;

export const FIELD_LABELS: Record<ImportField, string> = {
  name: "Product name",
  sku: "Product code / SKU",
  barcode: "Barcode",
  brandName: "Brand",
  genericName: "Generic name",
  manufacturer: "Manufacturer",
  dosageForm: "Dosage form",
  strength: "Strength",
  unit: "Unit",
  packSize: "Pack size",
  registrationNo: "NMRA registration no.",
  categoryName: "Category",
  reorderLevel: "Reorder level",
  qty: "Quantity on hand",
  costPrice: "Cost price",
  sellingPrice: "Selling price",
  batchNo: "Batch no.",
  expiryDate: "Expiry date",
};

export const FIELD_HINTS: Partial<Record<ImportField, string>> = {
  name: "The only column every row must have.",
  barcode: "Used first when matching against products you already have.",
  registrationNo: "Matches the NMRA register, carrying schedule and Rx flags across.",
  qty: "Map this to bring opening stock in from the same file.",
  sellingPrice: "Required for any row that carries a quantity.",
  expiryDate: "Missing dates are accepted and flagged for review.",
};

/** Product columns first, then the opening-stock group — the order the form shows them in. */
export const PRODUCT_FIELDS: ImportField[] = [
  "name",
  "barcode",
  "sku",
  "brandName",
  "genericName",
  "manufacturer",
  "dosageForm",
  "strength",
  "unit",
  "packSize",
  "registrationNo",
  "categoryName",
  "reorderLevel",
];

export const STOCK_FIELDS: ImportField[] = [
  "qty",
  "costPrice",
  "sellingPrice",
  "batchNo",
  "expiryDate",
];

export type ImportAnalysis = {
  headers: string[];
  totalRows: number;
  sampleRows: Array<Record<string, string>>;
  suggestedMapping: ImportMapping;
  unmappedHeaders: string[];
};

export type MatchConfidence =
  | "barcode"
  | "registration"
  | "name"
  | "normalized"
  | "fuzzy";

export const CONFIDENCE_LABELS: Record<MatchConfidence, string> = {
  barcode: "Barcode",
  registration: "Registration no.",
  name: "Exact name",
  normalized: "Name (normalised)",
  fuzzy: "Generic + strength",
};

export type ImportRowIssue = {
  rowNumber: number;
  name: string;
  message: string;
};

export type PendingComplianceMatch = {
  rowNumber: number;
  name: string;
  matchedProductId: string;
  matchedName: string;
  matchedRegistrationNo: string | null;
  wouldSetControlled: boolean;
  wouldSetPrescription: boolean;
};

export type ImportPreview = {
  totalRows: number;
  create: number;
  update: number;
  skip: number;
  withStock: number;
  unitsToPost: number;
  missingExpiry: number;
  matchCounts: Record<MatchConfidence, number>;
  issues: ImportRowIssue[];
  pendingCompliance: PendingComplianceMatch[];
  sampleCreates: Array<{ rowNumber: number; name: string; barcode: string | null }>;
  sampleMatches: Array<{
    rowNumber: number;
    name: string;
    matchedName: string;
    confidence: MatchConfidence;
  }>;
  hasStockColumns: boolean;
};

export type ImportResult = {
  importId: string;
  parsed: number;
  productsCreated: number;
  productsUpdated: number;
  productsRanged: number;
  batchesCreated: number;
  unitsPosted: number;
  rowsFailed: number;
  expiryReviewCount: number;
  issues: ImportRowIssue[];
};

export type ImportJobProgress = {
  jobId: string;
  importId: string;
  status: "queued" | "running" | "completed" | "failed";
  phase: string;
  processed: number;
  total: number;
  productsCreated: number;
  productsUpdated: number;
  batchesCreated: number;
  errorCount: number;
  result?: ImportResult;
  error?: string;
};

export type ImportSummary = {
  id: string;
  filename: string;
  status: "running" | "completed" | "failed" | "undone";
  branchId: string | null;
  createdAt: string;
  completedAt: string | null;
  undoneAt: string | null;
  productsCreated: number;
  productsUpdated: number;
  productsRanged: number;
  batchesCreated: number;
  unitsPosted: number;
  rowsFailed: number;
  expiryReviewCount: number;
  actorName: string | null;
  canUndo: boolean;
  undoBlockedReason: string | null;
};

export type ImportStep = "upload" | "map" | "review" | "running" | "done";
