import type { ImportCategoryPlan } from "./product-import-category";

export type {
  CategoryDecision,
  ImportCategoryChoices,
  ImportCategoryPlan,
  ImportCategoryPlanEntry,
} from "./product-import-category";

/**
 * Every field a customer's product export can be mapped onto.
 *
 * `name` is the only required one — everything else is genuinely optional, because the whole
 * point of the mapping step is that another system's export has whatever shape it has.
 */
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
  // Opening-stock columns — optional as a group, but qty is what turns the row into stock.
  "qty",
  "costPrice",
  "sellingPrice",
  "batchNo",
  "expiryDate",
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];

export const STOCK_FIELDS: ImportField[] = [
  "qty",
  "costPrice",
  "sellingPrice",
  "batchNo",
  "expiryDate",
];

/** Mapping from an import field to the uploaded file's column header. */
export type ImportMapping = Partial<Record<ImportField, string>>;

export type ImportAnalysis = {
  /** Column headers found in the file, in order. */
  headers: string[];
  totalRows: number;
  /** First few rows as header → cell text, so the user can sanity-check the mapping. */
  sampleRows: Array<Record<string, string>>;
  /** Best-guess mapping, pre-filled in the UI for the user to correct. */
  suggestedMapping: ImportMapping;
  /** Headers we could not place — surfaced so nothing silently disappears. */
  unmappedHeaders: string[];
};

export type MatchConfidence =
  | "barcode"
  | "registration"
  | "name"
  | "normalized"
  | "fuzzy";

export type ImportRowIssue = {
  rowNumber: number;
  name: string;
  message: string;
};

/**
 * A fuzzy match that would set `isControlled` or `requiresPrescription` on the imported row.
 * Never applied without the user saying so: a mis-linked row here either blocks a legitimate
 * sale or, worse, fails to block one that should have been blocked.
 */
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
  /** Rows held back: duplicates in the file, or unusable data. */
  skip: number;
  /** Rows that will post opening stock. */
  withStock: number;
  unitsToPost: number;
  /** Batches that would be accepted without a real expiry date. */
  missingExpiry: number;
  matchCounts: Record<MatchConfidence, number>;
  /** Where each distinct value of the Category column will land, and what needs a decision. */
  categoryPlan: ImportCategoryPlan;
  issues: ImportRowIssue[];
  pendingCompliance: PendingComplianceMatch[];
  sampleCreates: Array<{
    rowNumber: number;
    name: string;
    barcode: string | null;
  }>;
  sampleMatches: Array<{
    rowNumber: number;
    name: string;
    matchedName: string;
    confidence: MatchConfidence;
  }>;
  /** True when stock columns are mapped, so the caller knows a branch is required. */
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
  /** Filed under a category the file named. */
  categorizedFromFile: number;
  /** Filed by the deterministic keyword classifier, because the file said nothing usable. */
  categorizedByClassifier: number;
  /** Left in Unclassified Medicines for someone to place. */
  leftUnclassified: number;
  /**
   * Catalog-review work this import created, so the completion screen can say what is left to
   * do rather than only what happened. Each count deep-links into the Work Queue filtered to
   * this import.
   */
  catalogTasks: {
    total: number;
    needsCategory: number;
    nmraMatch: number;
    complianceReview: number;
    ambiguous: number;
  };
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
  /** Whether "undo this import" is still available, and why not when it isn't. */
  canUndo: boolean;
  undoBlockedReason: string | null;
};
