"use client";

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Alert } from "@/components/alert";
import { IconDownload } from "@/components/icons";
import { PageHeader } from "@/components/ui";
import { CatalogDiscoveryEmpty } from "./components/catalog-discovery-empty";
import { FacetFilters } from "./components/facet-filters";
import { ProductDetailPanel } from "./components/product-detail-panel";
import { QuickChips } from "./components/quick-chips";
import { ResultsTable } from "./components/results-table";
import { SearchHero } from "./components/search-hero";
import { useCatalogSearch } from "./hooks/use-catalog-search";
import css from "./catalog.module.css";
import {
  catalogItemsToCsv,
  clearFilters,
  filtersFromSearchParams,
  filtersToSearchParams,
  hasBrowseFilters,
  loadRecentSearches,
  loadRecentViews,
  pushRecentView,
} from "./utils";
import type { CatalogFilters, MatchType, RecentView } from "./types";

function CatalogContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const inputRef = useRef<HTMLInputElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const [, startTransition] = useTransition();
  const syncingFromUrl = useRef(false);

  const initial = useMemo(
    () => filtersFromSearchParams(new URLSearchParams(searchParams.toString())),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const [filters, setFilters] = useState<CatalogFilters>(initial);
  const [productId, setProductId] = useState<string | null>(
    () => searchParams.get("productId"),
  );
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [matchTab, setMatchTab] = useState<"all" | MatchType>("all");
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const [recentViews, setRecentViews] = useState<RecentView[]>([]);

  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const itemsRef = useRef<string[]>([]);
  const highlightRef = useRef(0);

  const {
    data,
    items,
    facets,
    loading,
    loadingMore,
    error,
    hasBranch,
    reload,
    loadMore,
    hasMore,
    truncated,
  } = useCatalogSearch({
    filters,
    matchTab,
    debounceMs: 280,
  });

  useEffect(() => {
    if (!data) return;
    setRecent(loadRecentSearches());
  }, [data]);

  useEffect(() => {
    setRecent(loadRecentSearches());
    setRecentViews(loadRecentViews());
  }, []);

  // Write URL from state
  useEffect(() => {
    if (syncingFromUrl.current) return;
    const handle = window.setTimeout(() => {
      const params = filtersToSearchParams(filters, productId);
      if (matchTab !== "all") params.set("match", matchTab);
      const qs = params.toString();
      const next = qs ? `/catalog?${qs}` : "/catalog";
      const current = `${window.location.pathname}${window.location.search}`;
      if (current === next) return;
      startTransition(() => {
        router.replace(next, { scroll: false });
      });
    }, 400);
    return () => window.clearTimeout(handle);
  }, [filters, productId, matchTab, router, startTransition]);

  // Read URL on back/forward
  useEffect(() => {
    const fromUrl = filtersFromSearchParams(
      new URLSearchParams(searchParams.toString()),
    );
    const urlProduct = searchParams.get("productId");
    const urlMatch = searchParams.get("match");
    const nextTab =
      urlMatch === "exact" ||
      urlMatch === "generic" ||
      urlMatch === "alias" ||
      urlMatch === "partial"
        ? urlMatch
        : "all";

    const cur = filtersToSearchParams(filters, productId).toString();
    const incoming = filtersToSearchParams(fromUrl, urlProduct).toString();
    if (cur === incoming && matchTab === nextTab) return;

    syncingFromUrl.current = true;
    setFilters(fromUrl);
    setProductId(urlProduct);
    setMatchTab(nextTab);
    queueMicrotask(() => {
      syncingFromUrl.current = false;
    });
    // Only react to searchParams identity changes (browser navigation)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const patchFilters = useCallback((patch: Partial<CatalogFilters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
    setHighlightIndex(0);
    highlightRef.current = 0;
  }, []);

  const selectProduct = useCallback(
    (id: string, name?: string) => {
      setProductId(id);
      setMobilePanelOpen(true);
      const label =
        name ??
        items.find((i) => i.id === id)?.name ??
        recentViews.find((v) => v.id === id)?.name;
      if (label) {
        setRecentViews(pushRecentView({ id, name: label }));
      }
    },
    [items, recentViews],
  );

  itemsRef.current = items.map((i) => i.id);
  highlightRef.current = highlightIndex;

  const selectedItem = useMemo(
    () => items.find((i) => i.id === productId) ?? null,
    [items, productId],
  );

  useEffect(() => {
    setHighlightIndex(0);
    highlightRef.current = 0;
  }, [filters.q, matchTab]);

  const prevQRef = useRef(filters.q);
  useEffect(() => {
    const prev = prevQRef.current;
    prevQRef.current = filters.q;
    if (prev.trim() && !filters.q.trim()) {
      setProductId(null);
      setMobilePanelOpen(false);
    }
  }, [filters.q]);

  const [scanArmed, setScanArmed] = useState(false);
  const scanArmedRef = useRef(false);
  scanArmedRef.current = scanArmed;
  const scanTimerRef = useRef<number | null>(null);

  const armScanMode = useCallback(() => {
    if (scanTimerRef.current) window.clearTimeout(scanTimerRef.current);
    setScanArmed(true);
    scanTimerRef.current = window.setTimeout(() => setScanArmed(false), 8000);
  }, []);

  useEffect(() => {
    return () => {
      if (scanTimerRef.current) window.clearTimeout(scanTimerRef.current);
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);

      if (e.key === "/" && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        return;
      }
      if (e.key === "Escape") {
        if (mobilePanelOpen) {
          setMobilePanelOpen(false);
          return;
        }
        if (productId) {
          setProductId(null);
          return;
        }
        if (document.activeElement === inputRef.current) {
          if (filtersRef.current.q) {
            patchFilters({ q: "" });
          } else {
            inputRef.current?.blur();
          }
        }
        return;
      }

      const ids = itemsRef.current;
      if (!ids.length) return;

      if (e.key === "ArrowDown") {
        if (typing && document.activeElement === inputRef.current) {
          e.preventDefault();
          inputRef.current?.blur();
        } else if (!typing) {
          e.preventDefault();
        } else {
          return;
        }
        setHighlightIndex((i) => {
          const next = Math.min(ids.length - 1, i + 1);
          highlightRef.current = next;
          return next;
        });
      } else if (e.key === "ArrowUp") {
        if (typing) return;
        e.preventDefault();
        setHighlightIndex((i) => {
          const next = Math.max(0, i - 1);
          highlightRef.current = next;
          return next;
        });
      } else if (e.key === "Enter") {
        if (typing && document.activeElement === inputRef.current) {
          e.preventDefault();
          reload();
          const id = ids[highlightRef.current] ?? ids[0];
          if (id) selectProduct(id);
          return;
        }
        if (!typing) {
          e.preventDefault();
          const id = ids[highlightRef.current];
          if (id) selectProduct(id);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [patchFilters, selectProduct, reload, mobilePanelOpen, productId]);

  // Focus trap for mobile sheet
  useEffect(() => {
    if (!mobilePanelOpen || !productId) return;
    const sheet = sheetRef.current;
    const focusable = sheet?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();
  }, [mobilePanelOpen, productId]);

  const showEmptyIntro =
    !filters.q.trim() &&
    !hasBrowseFilters(filters) &&
    !scanArmed &&
    !loading &&
    !data;
  const showScanReady =
    scanArmed && !filters.q.trim() && !hasBrowseFilters(filters);
  const showNoMatches =
    !loading &&
    !scanArmed &&
    !!data &&
    items.length === 0 &&
    (filters.q.trim().length >= 2 || hasBrowseFilters(filters));

  const scanBarcode = useCallback(() => {
    setFilters({
      ...clearFilters(false),
      exact: true,
    });
    setProductId(null);
    setMobilePanelOpen(false);
    setMatchTab("all");
    setHighlightIndex(0);
    highlightRef.current = 0;
    armScanMode();
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [armScanMode]);

  useEffect(() => {
    if (!scanArmed || !data || loading) return;
    const exactHits = items.filter((i) => i.matchType === "exact");
    if (exactHits.length === 1 && filters.q.trim().length >= 3) {
      const hit = exactHits[0]!;
      selectProduct(hit.id, hit.name);
      setScanArmed(false);
      if (scanTimerRef.current) window.clearTimeout(scanTimerRef.current);
    }
  }, [scanArmed, data, loading, filters.q, items, selectProduct]);

  const browseProducts = useCallback(() => {
    setFilters({
      ...clearFilters(false),
      inStock: true,
      stockStatus: "in",
    });
    setProductId(null);
    setMobilePanelOpen(false);
    setMatchTab("all");
    setScanArmed(false);
  }, []);

  const viewLowStock = useCallback(() => {
    setFilters({
      ...clearFilters(false),
      stockStatus: "low",
      inStock: false,
    });
    setProductId(null);
    setMobilePanelOpen(false);
    setMatchTab("all");
    setScanArmed(false);
  }, []);

  const exportCsv = useCallback(() => {
    if (items.length === 0) return;
    const csv = catalogItemsToCsv(items);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `catalog-search-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [items]);

  const panelProps = {
    productId,
    fallback: selectedItem,
    onSelectProduct: selectProduct,
    onScanBarcode: scanBarcode,
    onBrowse: browseProducts,
    onLowStock: viewLowStock,
  };

  return (
    <div className={css.page}>
      <PageHeader
        subtitleOnly
        description="Find products quickly using names, SKUs, barcodes, aliases, stock, and catalog attributes."
      />

      {!hasBranch ? (
        <Alert variant="warning">
          Select a branch in the header to see sellable stock and sell prices.
        </Alert>
      ) : null}

      {error ? <Alert variant="error">{error}</Alert> : null}

      <div className={css.shell}>
        <div className={css.mainCol}>
          <div className={css.hero}>
            <SearchHero
              value={filters.q}
              inputRef={inputRef}
              scanArmed={scanArmed}
              onChange={(q) => patchFilters({ q })}
              onClear={() => {
                patchFilters({ q: "" });
                setProductId(null);
                setMobilePanelOpen(false);
              }}
              onScanBarcode={scanBarcode}
            />
            <QuickChips
              filters={filters}
              facets={facets}
              onChange={patchFilters}
            />
            <FacetFilters
              filters={filters}
              facets={facets}
              resultCount={data?.total ?? null}
              onChange={patchFilters}
              onClear={() => {
                const keepQ = filtersRef.current.q;
                setFilters(clearFilters(true, keepQ));
                setHighlightIndex(0);
                if (!keepQ.trim()) {
                  setProductId(null);
                  setMobilePanelOpen(false);
                }
              }}
            />
          </div>

          {showEmptyIntro ? (
            <CatalogDiscoveryEmpty
              recent={recent}
              facets={facets}
              recentViews={recentViews}
              onSearch={(q) => patchFilters({ q })}
              onCategory={(categoryId) =>
                patchFilters({ commercialCategoryIds: [categoryId] })
              }
              onSelectProduct={selectProduct}
            />
          ) : showScanReady ? (
            <div className={css.emptyState} role="status">
              <h2>Ready to scan</h2>
              <p>
                Exact match is on. Point a USB barcode scanner here, or type the
                barcode / SKU and press Enter. A single exact hit opens
                automatically.
              </p>
            </div>
          ) : (
            <>
              <div className={css.resultsHead}>
                <div className={css.resultsMeta} aria-live="polite">
                  {loading && !data ? (
                    "Searching…"
                  ) : (
                    <>
                      <strong>{data?.total ?? 0}</strong> results
                      {filters.q.trim() ? (
                        <>
                          {" "}
                          for <strong>“{filters.q.trim()}”</strong>
                        </>
                      ) : null}
                      {matchTab !== "all" ? (
                        <>
                          {" "}
                          · showing <strong>{items.length}</strong> loaded
                        </>
                      ) : null}
                      {loading ? (
                        <span className={css.searchingHint}> · updating…</span>
                      ) : null}
                      {truncated ? (
                        <span className={css.searchingHint}>
                          {" "}
                          · large catalog — refine for complete coverage
                        </span>
                      ) : null}
                    </>
                  )}
                </div>
                <div className={css.resultsActions}>
                  <button
                    type="button"
                    className={css.exportBtn}
                    onClick={exportCsv}
                    disabled={items.length === 0}
                    data-tooltip="Download current results as CSV"
                  >
                    <IconDownload size={14} />
                    Export
                  </button>
                  <div className={css.tabs} role="tablist" aria-label="Match type">
                    {(
                      [
                        ["all", "All"],
                        ["exact", `Exact (${data?.exactCount ?? 0})`],
                        ["generic", `Generic (${data?.genericCount ?? 0})`],
                        ["alias", `Alias (${data?.aliasCount ?? 0})`],
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        role="tab"
                        aria-selected={matchTab === key}
                        className={`${css.tab}${matchTab === key ? ` ${css.tabActive}` : ""}`}
                        onClick={() => setMatchTab(key)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {showNoMatches ? (
                <div className={css.emptyState}>
                  <h2>No matches</h2>
                  <p>Try a shorter query, clear Exact match, or remove stock filters.</p>
                  <button
                    type="button"
                    className={css.clearFilter}
                    onClick={() => {
                      setFilters(clearFilters(false));
                      setMatchTab("all");
                      setScanArmed(false);
                    }}
                  >
                    Clear filters
                  </button>
                </div>
              ) : items.length > 0 ? (
                <>
                  <div className={loading ? css.resultsDim : undefined}>
                    <ResultsTable
                      items={items}
                      selectedId={productId}
                      highlightIndex={highlightIndex}
                      onSelect={(id) => {
                        const row = items.find((i) => i.id === id);
                        selectProduct(id, row?.name);
                      }}
                    />
                  </div>
                  {hasMore ? (
                    <div className={css.loadMoreWrap}>
                      <button
                        type="button"
                        className={css.loadMoreBtn}
                        onClick={loadMore}
                        disabled={loadingMore}
                      >
                        {loadingMore ? "Loading…" : "Load more"}
                      </button>
                    </div>
                  ) : null}
                </>
              ) : loading ? (
                <div className={css.loading}>Searching…</div>
              ) : null}
            </>
          )}
        </div>

        <div className={css.desktopPanel}>
          <ProductDetailPanel {...panelProps} />
        </div>
      </div>

      {mobilePanelOpen && productId ? (
        <div
          className={css.overlay}
          role="dialog"
          aria-modal="true"
          aria-label="Product details"
          onClick={(e) => {
            if (e.target === e.currentTarget) setMobilePanelOpen(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setMobilePanelOpen(false);
          }}
        >
          <div className={css.sheet} ref={sheetRef}>
            <ProductDetailPanel
              {...panelProps}
              compact
              onClose={() => setMobilePanelOpen(false)}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function CatalogPage() {
  return (
    <Suspense fallback={<div className={css.loading}>Loading catalog…</div>}>
      <CatalogContent />
    </Suspense>
  );
}
