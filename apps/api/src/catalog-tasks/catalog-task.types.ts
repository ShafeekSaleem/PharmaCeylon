import type { CatalogTaskStatus, CatalogTaskType } from "@prisma/client";

/** The two statuses that count as outstanding work anywhere a badge or a total is shown. */
export const OPEN_STATUSES: CatalogTaskStatus[] = ["OPEN", "NEEDS_REVIEW"];

/** What a MISSING_CATEGORY task proposes. */
export type CategorySuggestion = {
  categoryId: string;
  categoryName: string;
  categoryPath: string;
};

/** What an NMRA_MATCH task proposes. */
export type ReferenceSuggestion = {
  referenceProductId: string;
  name: string;
  brandName: string | null;
  registrationNo: string | null;
  isControlled: boolean;
  requiresPrescription: boolean;
};

export type CatalogTaskSuggestion = CategorySuggestion | ReferenceSuggestion | null;

export type CatalogTaskProduct = {
  id: string;
  name: string;
  sku: string;
  brandName: string | null;
  genericName: string | null;
  dosageForm: string | null;
  strength: string | null;
  barcode: string | null;
  registrationNo: string | null;
  source: string;
  isControlled: boolean;
  requiresPrescription: boolean;
};

export type CatalogTaskView = {
  id: string;
  type: CatalogTaskType;
  status: CatalogTaskStatus;
  product: CatalogTaskProduct;
  suggestion: CatalogTaskSuggestion;
  evidence: string | null;
  /** Human wording for `evidence`, resolved server-side so every surface says the same thing. */
  evidenceLabel: string | null;
  confidence: number | null;
  complianceImpact: boolean;
  safeToApply: boolean;
  candidates: Array<{ id: string; name: string; brandName: string | null; registrationNo: string | null }>;
  importId: string | null;
  importFilename: string | null;
  sourceRow: number | null;
  detail: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
};

export type CatalogTaskSummary = {
  open: number;
  needsCategory: number;
  nmraMatch: number;
  complianceReview: number;
  ambiguous: number;
  noSuggestion: number;
  safeToApply: number;
  /** Open tasks whose product came from an import in the last 7 days. */
  fromRecentImports: number;
  resolved: number;
  dismissed: number;
  notApplicable: number;
  /** Ranged products with a primary commercial category, as a share of the range. */
  categoryCoveragePercent: number;
};

export type CatalogTaskFilter = {
  status?: CatalogTaskStatus[];
  type?: CatalogTaskType[];
  /** "compliance" | "ambiguous" | "no_suggestion" | "safe" — cross-cutting views over the queue. */
  view?: string;
  q?: string;
  importId?: string;
  source?: string;
  createdFrom?: Date;
  createdTo?: Date;
  skip?: number;
  take?: number;
};

/** Evidence tier → what a pharmacist should read. Keys match `RankedMatchEvidence` plus ours. */
export const EVIDENCE_LABELS: Record<string, string> = {
  barcode: "Exact barcode",
  registration: "Exact registration no.",
  name: "Exact name",
  normalized: "Near-identical name",
  fuzzy: "Substance + strength + form",
  inn_head: "Substance name",
  name_rule: "Product name rule",
  generic_rule: "Generic name rule",
  form_rule: "Dosage form rule",
  imported_category: "Imported category value",
};

export function evidenceLabel(evidence: string | null): string | null {
  if (!evidence) return null;
  return EVIDENCE_LABELS[evidence] ?? evidence;
}
