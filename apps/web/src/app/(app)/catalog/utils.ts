import type {
  CatalogFilters,
  CatalogSearchItem,
  MatchType,
  RecentView,
  StockStatus,
} from "./types";
import {
  DEFAULT_FILTERS,
  MAX_RECENT,
  MAX_RECENT_VIEWS,
  RECENT_SEARCHES_KEY,
  RECENT_VIEWS_KEY,
} from "./types";

export function formatLkr(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `LKR ${value.toLocaleString("en-LK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function matchTypeLabel(type: MatchType): string {
  switch (type) {
    case "exact":
      return "Exact";
    case "generic":
      return "Generic";
    case "alias":
      return "Alias";
    default:
      return "Partial";
  }
}

export function stockStatusLabel(status: StockStatus | null | undefined): string {
  if (status === "out") return "Out of stock";
  if (status === "low") return "Low stock";
  if (status === "healthy") return "Healthy";
  return "—";
}

export function hasActiveFilters(f: CatalogFilters): boolean {
  return Boolean(
    f.exact ||
      f.inStock ||
      f.controlled ||
      f.dosageForm ||
      f.brandName ||
      f.commercialCategoryIds.length ||
      f.tagId ||
      f.stockStatus,
  );
}

/** Filters that browse/list without needing a query (excludes Exact-only). */
export function hasBrowseFilters(f: CatalogFilters): boolean {
  return Boolean(
    f.inStock ||
      f.controlled ||
      f.dosageForm ||
      f.brandName ||
      f.commercialCategoryIds.length ||
      f.tagId ||
      f.stockStatus,
  );
}

export function filtersFromSearchParams(params: URLSearchParams): CatalogFilters {
  const stockStatus = (params.get("stock") as CatalogFilters["stockStatus"]) || "";
  const inStock = stockStatus === "in" || params.get("inStock") === "1";
  const categoryParam = params.get("categoryId") ?? "";
  return {
    q: params.get("q") ?? "",
    exact: params.get("exact") === "1",
    inStock,
    controlled: params.get("controlled") === "1",
    dosageForm: params.get("dosageForm") ?? "",
    brandName: params.get("brandName") ?? "",
    commercialCategoryIds: categoryParam
      ? [...new Set(categoryParam.split(",").map((s) => s.trim()).filter(Boolean))]
      : [],
    tagId: params.get("tagId") ?? "",
    stockStatus: stockStatus || (inStock ? "in" : ""),
  };
}

export function filtersToSearchParams(
  f: CatalogFilters,
  productId?: string | null,
): URLSearchParams {
  const params = new URLSearchParams();
  if (f.q.trim()) params.set("q", f.q.trim());
  if (f.exact) params.set("exact", "1");
  if (f.controlled) params.set("controlled", "1");
  if (f.dosageForm) params.set("dosageForm", f.dosageForm);
  if (f.brandName) params.set("brandName", f.brandName);
  if (f.commercialCategoryIds.length) params.set("categoryId", f.commercialCategoryIds.join(","));
  if (f.tagId) params.set("tagId", f.tagId);
  const stock = f.stockStatus || (f.inStock ? "in" : "");
  if (stock) params.set("stock", stock);
  if (productId) params.set("productId", productId);
  return params;
}

export function buildSearchQuery(
  f: CatalogFilters,
  opts?: { skip?: number; take?: number; matchType?: string },
): string {
  const params = new URLSearchParams();
  if (f.q.trim()) params.set("q", f.q.trim());
  if (f.exact) params.set("exact", "true");
  if (f.inStock || f.stockStatus === "in") params.set("inStock", "true");
  if (f.stockStatus === "out") params.set("outOfStock", "true");
  if (f.stockStatus === "low") params.set("lowStock", "true");
  if (f.controlled) params.set("isControlled", "true");
  if (f.dosageForm) params.set("dosageForm", f.dosageForm);
  if (f.brandName) params.set("brandName", f.brandName);
  if (f.commercialCategoryIds.length) {
    params.set("commercialCategoryId", f.commercialCategoryIds.join(","));
  }
  if (f.tagId) params.set("tagId", f.tagId);
  if (opts?.matchType && opts.matchType !== "all") {
    params.set("matchType", opts.matchType);
  }
  params.set("take", String(opts?.take ?? 40));
  if (opts?.skip && opts.skip > 0) params.set("skip", String(opts.skip));
  return params.toString();
}

export function catalogItemsToCsv(items: CatalogSearchItem[]): string {
  const header = [
    "SKU",
    "Barcode",
    "Name",
    "Generic",
    "Brand",
    "Form",
    "Strength",
    "Match",
    "Stock",
    "Qty",
    "SellPrice",
    "Controlled",
  ];
  const rows = items.map((i) => [
    i.sku,
    i.barcode ?? "",
    i.name,
    i.genericName ?? "",
    i.brandName ?? "",
    i.dosageForm ?? "",
    i.strength ?? "",
    i.matchType,
    i.stockStatus ?? "",
    i.qtyOnHand == null ? "" : String(i.qtyOnHand),
    i.sellPrice == null ? "" : String(i.sellPrice),
    i.isControlled ? "yes" : "no",
  ]);
  return [header, ...rows]
    .map((cols) => cols.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
    .join("\n");
}

export function clearFilters(keepQ = true, q = ""): CatalogFilters {
  return { ...DEFAULT_FILTERS, q: keepQ ? q : "" };
}

export function loadRecentSearches(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(RECENT_SEARCHES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

export function pushRecentSearch(term: string): string[] {
  const t = term.trim();
  if (t.length < 2) return loadRecentSearches();
  const next = [t, ...loadRecentSearches().filter((x) => x.toLowerCase() !== t.toLowerCase())].slice(
    0,
    MAX_RECENT,
  );
  try {
    localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}

export function reasonLabel(reason: string): string {
  if (reason === "same_generic_form_strength") return "Same generic / form / strength";
  return reason.replace(/_/g, " ");
}

export function loadRecentViews(): RecentView[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(RECENT_VIEWS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (x): x is RecentView =>
          !!x &&
          typeof x === "object" &&
          typeof (x as RecentView).id === "string" &&
          typeof (x as RecentView).name === "string",
      )
      .slice(0, MAX_RECENT_VIEWS);
  } catch {
    return [];
  }
}

export function pushRecentView(item: RecentView): RecentView[] {
  if (!item.id || !item.name.trim()) return loadRecentViews();
  const next = [
    item,
    ...loadRecentViews().filter((x) => x.id !== item.id),
  ].slice(0, MAX_RECENT_VIEWS);
  try {
    localStorage.setItem(RECENT_VIEWS_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}
