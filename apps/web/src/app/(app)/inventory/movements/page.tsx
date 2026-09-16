"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import { IconPlus } from "@/components/icons";
import { ProductContextBanner } from "@/components/product-context-banner";
import {
  ActionButton,
  ActiveFilterBanner,
  DateRangeField,
  PageHeader,
  type FilterPill,
} from "@/components/ui";
import { AdjustmentModal } from "../components/adjustment-modal";
import { InventoryFilterSelect } from "../components/inventory-filter-select";
import { InventorySubnav } from "../components/inventory-subnav";
import { MovementsTable } from "../components/movements-table";
import { useInventoryAccess } from "../hooks/use-inventory-access";
import { useInventoryMovements, useMovementActors } from "../hooks/use-inventory-movements";
import { useInventoryStock } from "../hooks/use-inventory-stock";
import css from "../inventory.module.css";
import type { MovementCategory } from "../types";

const PAGE_SIZE = 15;

const CATEGORY_OPTIONS: { value: MovementCategory; label: string }[] = [
  { value: "all", label: "All types" },
  { value: "sales", label: "Sales, voids & refunds" },
  { value: "purchases", label: "Goods received" },
  { value: "transfers", label: "Transfers" },
  { value: "returns", label: "Returns" },
  { value: "adjustments", label: "Adjustments" },
  { value: "stocktakes", label: "Stocktakes" },
  { value: "quarantine", label: "Quarantine & release" },
  { value: "opening", label: "Opening stock" },
];

function MovementsContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const access = useInventoryAccess();
  const canAdjust = access.canAdjustIn || access.canWriteOff;

  const productId = searchParams.get("productId");
  const batchId = searchParams.get("batchId");
  const category = ((): MovementCategory => {
    const value = searchParams.get("category");
    return CATEGORY_OPTIONS.some((o) => o.value === value) ? (value as MovementCategory) : "all";
  })();
  const userId = searchParams.get("userId");
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  const [page, setPage] = useState(1);
  const [productSearch, setProductSearch] = useState("");
  const [debouncedProductSearch, setDebouncedProductSearch] = useState("");
  const stock = useInventoryStock({ q: debouncedProductSearch, page: 1, pageSize: 50 });
  const selectedStock = useInventoryStock({ productId: productId || null, page: 1, pageSize: 1 });
  const actors = useMovementActors();
  const [adjustmentOpen, setAdjustmentOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedProductSearch(productSearch), 250);
    return () => clearTimeout(t);
  }, [productSearch]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  /** Filters live in the URL, so a filtered history can be shared or bookmarked. */
  const setParam = useCallback(
    (updates: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [pathname, router, searchParams],
  );

  useEffect(() => {
    setPage(1);
  }, [productId, batchId, category, userId, from, to]);

  const movements = useInventoryMovements({
    productId,
    batchId,
    category,
    userId,
    from,
    to,
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
  });

  const productOptions = useMemo(
    () => [
      ...new Map(
        [...selectedStock.rows, ...stock.rows].map((row) => [
          row.productId,
          { value: row.productId, label: `${row.product.sku} — ${row.product.name}` },
        ]),
      ).values(),
    ],
    [selectedStock.rows, stock.rows],
  );
  const productName = selectedStock.rows.find((row) => row.productId === productId)?.product.name;
  const batchNo = movements.rows.find((row) => row.batchId === batchId)?.batchNo;

  const filtersActive = Boolean(productId || batchId || category !== "all" || userId || from || to);
  const pills: FilterPill[] = [
    ...(productId ? [{ key: "product", label: `Product: ${productName ?? "Selected"}` }] : []),
    ...(batchId ? [{ key: "batch", label: `Batch: ${batchNo ?? "Selected"}` }] : []),
    ...(category !== "all"
      ? [{ key: "type", label: CATEGORY_OPTIONS.find((o) => o.value === category)?.label ?? category }]
      : []),
    ...(userId
      ? [{ key: "user", label: `User: ${actors.find((a) => a.id === userId)?.fullName ?? "Selected"}` }]
      : []),
    ...(from ? [{ key: "from", label: `From ${from}` }] : []),
    ...(to ? [{ key: "to", label: `To ${to}` }] : []),
  ];

  return (
    <>
      <ProductContextBanner />

      <PageHeader
        subtitleOnly
        floatingActions
        description="Every stock change at this branch — sales, receipts, transfers, returns, stocktakes, adjustments and quarantine."
        actions={
          canAdjust ? (
            <ActionButton
              icon={<IconPlus size={16} />}
              tooltip="Add stock or write stock off on a batch"
              onClick={() => setAdjustmentOpen(true)}
            >
              New adjustment
            </ActionButton>
          ) : null
        }
      />

      <InventorySubnav />

      {notice && <Alert variant="success">{notice}</Alert>}

      {!movements.hasBranch && (
        <div className={css.branchNotice}>Select a branch in the header to view movement history.</div>
      )}

      {movements.hasBranch && (
        <>
          <div className={`${css.toolbar} ${css.movementsToolbar}`}>
            <div className={css.movementsProductFilter}>
              <InventoryFilterSelect
                label="Product"
                value={productId ?? ""}
                placeholder="All products"
                allowDeselect
                options={productOptions}
                searchable
                searchPlaceholder="Search by product or SKU…"
                onSearchChange={setProductSearch}
                onChange={(id) => setParam({ productId: id || null, batchId: null })}
                disabled={stock.loading && selectedStock.loading}
              />
            </div>
            <InventoryFilterSelect
              label="Movement type"
              value={category}
              options={CATEGORY_OPTIONS}
              onChange={(value) => setParam({ category: value === "all" ? null : value })}
            />
            <InventoryFilterSelect
              label="User"
              value={userId ?? ""}
              placeholder="Anyone"
              allowDeselect
              options={actors.map((actor) => ({ value: actor.id, label: actor.fullName }))}
              onChange={(value) => setParam({ userId: value || null })}
            />
            <DateRangeField
              label="Movement dates"
              size="lg"
              from={from ?? ""}
              to={to ?? ""}
              onFromChange={(value) => setParam({ from: value || null })}
              onToChange={(value) => setParam({ to: value || null })}
            />
          </div>

          {movements.error && (
            <Alert variant="error">
              {movements.error}{" "}
              <button type="button" className={css.rowTitleButton} onClick={() => movements.reload()}>
                Try again
              </button>
            </Alert>
          )}

          <ActiveFilterBanner
            active={filtersActive}
            summary={`Filtered movements · ${movements.total} result${movements.total === 1 ? "" : "s"}`}
            pills={pills}
            onClear={() =>
              setParam({ productId: null, batchId: null, category: null, userId: null, from: null, to: null })
            }
            clearTooltip="Show every movement at this branch"
          />

          {!movements.loading && movements.total > 0 && (
            <div className={css.movementSummary} aria-label="Movement totals for current filters">
              <span>
                <strong>{movements.total}</strong> movement{movements.total === 1 ? "" : "s"}
              </span>
              <span>
                <span className={css.movementSummaryIn}>+{movements.summary.unitsIn}</span> units in
              </span>
              <span>
                <span className={css.movementSummaryOut}>−{movements.summary.unitsOut}</span> units out
              </span>
              <span>
                Net{" "}
                <span
                  className={
                    movements.summary.netDelta >= 0
                      ? css.movementSummaryNetPositive
                      : css.movementSummaryNetNegative
                  }
                >
                  {movements.summary.netDelta >= 0 ? "+" : ""}
                  {movements.summary.netDelta}
                </span>{" "}
                units
              </span>
              {!movements.balanceAvailable && (productId || batchId) && (
                <span className={css.productMeta}>
                  Clear the type, user and date filters to see the running balance.
                </span>
              )}
            </div>
          )}

          <MovementsTable
            rows={movements.rows}
            total={movements.total}
            loading={movements.loading}
            page={page}
            pageSize={PAGE_SIZE}
            showProduct={!productId}
            showBalance={movements.balanceAvailable}
            onPageChange={setPage}
            emptyTitle={filtersActive ? "No stock movements match your filters" : "No stock has moved at this branch yet"}
            emptyDescription={filtersActive ? "Try another product, type, user or date range" : undefined}
          />
        </>
      )}

      <AdjustmentModal
        open={adjustmentOpen}
        onClose={() => setAdjustmentOpen(false)}
        initialProductId={productId ?? ""}
        initialBatchId={batchId ?? ""}
        onSuccess={(message) => {
          setNotice(message);
          movements.reload();
        }}
      />
    </>
  );
}

export default function InventoryMovementsPage() {
  return (
    <Suspense fallback={<div className={css.loading}>Loading movements…</div>}>
      <MovementsContent />
    </Suspense>
  );
}
