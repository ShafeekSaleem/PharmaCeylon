"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { ProductContextBanner } from "@/components/product-context-banner";
import { PageHeader } from "@/components/ui";
import { MovementsTable } from "../components/movements-table";
import { InventoryFilterSelect } from "../components/inventory-filter-select";
import { useInventoryMovements } from "../hooks/use-inventory-movements";
import { useInventoryStock } from "../hooks/use-inventory-stock";
import css from "../inventory.module.css";
import type { MovementCategory } from "../types";

const PAGE_SIZE = 15;

const CATEGORY_OPTIONS = [
  { value: "all", label: "All types" },
  { value: "adjustments", label: "Adjustments" },
  { value: "sales", label: "Sales" },
  { value: "purchases", label: "Purchases" },
  { value: "transfers", label: "Transfers" },
  { value: "returns", label: "Returns" },
] as const;

function MovementsContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const productId = searchParams.get("productId");
  const initialCategory = (searchParams.get("category") as MovementCategory | null) ?? "all";
  const [category, setCategory] = useState<MovementCategory>(
    CATEGORY_OPTIONS.some((o) => o.value === initialCategory) ? initialCategory : "all",
  );
  const [page, setPage] = useState(1);
  const stock = useInventoryStock("all", "");

  const setProductFilter = useCallback(
    (id: string) => {
      const next = new URLSearchParams(searchParams.toString());
      if (id) next.set("productId", id);
      else next.delete("productId");
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [pathname, router, searchParams],
  );

  const setCategoryFilter = useCallback(
    (value: MovementCategory) => {
      setCategory(value);
      const next = new URLSearchParams(searchParams.toString());
      if (value && value !== "all") next.set("category", value);
      else next.delete("category");
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [pathname, router, searchParams],
  );

  useEffect(() => {
    setPage(1);
  }, [productId, category]);

  const movements = useInventoryMovements({
    productId,
    category,
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
  });

  const emptyDescription =
    category === "adjustments"
      ? undefined
      : "Try another product or movement type filter";

  return (
    <>
      <ProductContextBanner />

      <PageHeader
        subtitleOnly
        description="Full ledger of stock changes at this branch — sales, receipts, transfers, adjustments, and returns."
      />

      {!movements.hasBranch && (
        <div className={css.branchNotice}>
          Select a branch in the header to view movement history.
        </div>
      )}

      {movements.error && <Alert variant="error">{movements.error}</Alert>}

      {movements.hasBranch && (
        <>
          <div className={`${css.toolbar} ${css.movementsToolbar}`}>
            <div className={css.movementsProductFilter}>
              <InventoryFilterSelect
                label="Product"
                value={productId ?? ""}
                placeholder="All products"
                allowDeselect
                options={stock.rows.map((row) => ({
                  value: row.productId,
                  label: `${row.product.sku} — ${row.product.name}`,
                }))}
                searchable
                searchPlaceholder="Search by product or SKU…"
                onChange={setProductFilter}
                disabled={stock.loading}
              />
            </div>
            <InventoryFilterSelect
              label="Movement type"
              value={category}
              options={CATEGORY_OPTIONS}
              onChange={(value) => setCategoryFilter(value as MovementCategory)}
              disabled={movements.loading}
            />
          </div>

          {!movements.loading && movements.total > 0 && (
            <div className={css.movementSummary} aria-label="Movement totals for current filters">
              <span>
                <strong>{movements.total}</strong> movement{movements.total === 1 ? "" : "s"}
              </span>
              <span>
                <span className={css.movementSummaryIn}>+{movements.summary.unitsIn}</span> units in
              </span>
              <span>
                <span className={css.movementSummaryOut}>−{movements.summary.unitsOut}</span> units
                out
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
            </div>
          )}

          {category === "adjustments" &&
          !movements.loading &&
          movements.rows.length === 0 ? (
            <div className={css.empty}>
              <p>No stock movements match your filters.</p>
              <p>
                Post a new adjustment from the{" "}
                <Link href={`/inventory/adjustments${productId ? `?productId=${productId}` : ""}`}>
                  Adjustments
                </Link>{" "}
                tab.
              </p>
            </div>
          ) : (
            <MovementsTable
              rows={movements.rows}
              total={movements.total}
              loading={movements.loading}
              page={page}
              pageSize={PAGE_SIZE}
              productId={productId}
              onPageChange={setPage}
              emptyDescription={emptyDescription}
            />
          )}
        </>
      )}
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
