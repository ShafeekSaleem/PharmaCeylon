import { apiJson } from "@/lib/auth-client";

/** Mirrors `CatalogTaskType` on the API. */
export type CatalogTaskType =
  | "MISSING_CATEGORY"
  | "NMRA_MATCH"
  | "NMRA_AMBIGUOUS"
  | "IMPORT_DUPLICATE";

/** Mirrors `CatalogTaskStatus`. OPEN and NEEDS_REVIEW are the two that count as outstanding. */
export type CatalogTaskStatus =
  | "OPEN"
  | "NEEDS_REVIEW"
  | "RESOLVED"
  | "DISMISSED"
  | "NOT_APPLICABLE";

export type CategorySuggestion = {
  categoryId: string;
  categoryName: string;
  categoryPath: string;
};

export type ReferenceSuggestion = {
  referenceProductId: string;
  name: string;
  brandName: string | null;
  registrationNo: string | null;
  isControlled: boolean;
  requiresPrescription: boolean;
};

export type CatalogTask = {
  id: string;
  type: CatalogTaskType;
  status: CatalogTaskStatus;
  product: {
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
  suggestion: CategorySuggestion | ReferenceSuggestion | null;
  evidence: string | null;
  evidenceLabel: string | null;
  confidence: number | null;
  complianceImpact: boolean;
  safeToApply: boolean;
  candidates: Array<{
    id: string;
    name: string;
    brandName: string | null;
    registrationNo: string | null;
  }>;
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
  fromRecentImports: number;
  resolved: number;
  dismissed: number;
  notApplicable: number;
  categoryCoveragePercent: number;
};

export type CatalogTaskQuery = {
  status?: CatalogTaskStatus[];
  type?: CatalogTaskType[];
  view?: string;
  q?: string;
  importId?: string;
  source?: string;
  createdFrom?: string;
  createdTo?: string;
  skip?: number;
  take?: number;
};

/** Only the keys the query actually carries, so a bookmarked URL stays readable. */
export function catalogTaskParams(query: CatalogTaskQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.status?.length) params.set("status", query.status.join(","));
  if (query.type?.length) params.set("type", query.type.join(","));
  if (query.view && query.view !== "all") params.set("view", query.view);
  if (query.q?.trim()) params.set("q", query.q.trim());
  if (query.importId) params.set("importId", query.importId);
  if (query.source) params.set("source", query.source);
  if (query.createdFrom) params.set("createdFrom", query.createdFrom);
  if (query.createdTo) params.set("createdTo", query.createdTo);
  if (query.skip) params.set("skip", String(query.skip));
  if (query.take) params.set("take", String(query.take));
  return params;
}

export function fetchCatalogTaskSummary(): Promise<CatalogTaskSummary> {
  return apiJson<CatalogTaskSummary>("/catalog-tasks/summary");
}

export function fetchCatalogTasks(
  query: CatalogTaskQuery,
): Promise<{ items: CatalogTask[]; total: number; skip: number; take: number }> {
  const qs = catalogTaskParams(query).toString();
  return apiJson(`/catalog-tasks${qs ? `?${qs}` : ""}`);
}

/** Recompute the queue. Called when Catalog Management opens, so it is never stale on arrival. */
export function refreshCatalogTasks(importId?: string): Promise<{
  created: number;
  updated: number;
  closed: number;
}> {
  return apiJson("/catalog-tasks/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(importId ? { importId } : {}),
  });
}

export function applyCatalogTask(
  taskId: string,
  override?: { categoryId?: string; referenceProductId?: string },
): Promise<CatalogTask> {
  return apiJson(`/catalog-tasks/${taskId}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(override ?? {}),
  });
}

export function closeCatalogTask(
  taskId: string,
  action: "dismiss" | "not-applicable" | "reopen",
  note?: string,
): Promise<CatalogTask> {
  return apiJson(`/catalog-tasks/${taskId}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(note ? { note } : {}),
  });
}

/**
 * Applies every task the *current filter* marks safe. The filter travels with the request so
 * the number applied is exactly the number the button offered — see `applySafe` on the API.
 */
export function applySafeCatalogTasks(
  query: CatalogTaskQuery,
  expected: number,
): Promise<{ applied: number; failed: Array<{ taskId: string; reason: string }> }> {
  return apiJson("/catalog-tasks/apply-safe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      status: query.status,
      type: query.type,
      view: query.view === "all" ? undefined : query.view,
      q: query.q,
      importId: query.importId,
      source: query.source,
      createdFrom: query.createdFrom,
      createdTo: query.createdTo,
      expected,
    }),
  });
}

// ── Reference catalog ────────────────────────────────────────────────────────

export type ReferenceAddPreview = {
  items: Array<{
    referenceProductId: string;
    name: string;
    allowed: boolean;
    needsReview: boolean;
    reason: string | null;
    warnings: string[];
  }>;
  addable: number;
  needsReview: number;
  blocked: number;
};

export function previewReferenceAdd(referenceProductIds: string[]): Promise<ReferenceAddPreview> {
  return apiJson("/products/reference/preview-add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ referenceProductIds }),
  });
}

export function addReferenceProducts(
  referenceProductIds: string[],
  acknowledgeWarnings: boolean,
): Promise<{
  added: string[];
  held: Array<{ referenceProductId: string; name: string; reason: string }>;
}> {
  return apiJson("/products/reference/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ referenceProductIds, acknowledgeWarnings }),
  });
}

export type RangeExitResult = {
  changed: number;
  unranged: string[];
  deactivated: string[];
  blocked: Array<{ productId: string; reason: string }>;
  notes: string[];
};

export function exitRange(productIds: string[]): Promise<RangeExitResult> {
  return apiJson("/products/range/exit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productIds }),
  });
}
