"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { IconPlus } from "@/components/icons";
import { ProductContextBanner } from "@/components/product-context-banner";
import { RoleButton } from "@/components/role-access";
import { ActionButton, PageHeader } from "@/components/ui";
import { usePermissions } from "@/lib/permissions";
import { AdjustmentModal } from "../components/adjustment-modal";
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
  const { permissionKeys } = usePermissions();
  const canWrite = permissionKeys.includes("inventory.manage");
  const productId = searchParams.get("productId");
  const initialCategory = (searchParams.get("category") as MovementCategory | null) ?? "all";
  const [category, setCategory] = useState<MovementCategory>(
    CATEGORY_OPTIONS.some((o) => o.value === initialCategory) ? initialCategory : "all",
  );
  const [page, setPage] = useState(1);
  const [productSearch, setProductSearch] = useState("");
  const [debouncedProductSearch, setDebouncedProductSearch] = useState("");
  const stock = useInventoryStock({
    q: debouncedProductSearch,
    page: 1,
    pageSize: 50,
  });
  const selectedStock = useInventoryStock({
    productId: productId || null,
    page: 1,
    pageSize: 1,
  });
  const [adjustmentOpen, setAdjustmentOpen] = useState(false);
  const [adjustmentSuccess, setAdjustmentSuccess] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedProductSearch(productSearch), 250);
    return () => clearTimeout(t);
  }, [productSearch]);

  useEffect(() => {
    if (!adjustmentSuccess) return;
    const t = setTimeout(() => setAdjustmentSuccess(null), 6000);
    return () => clearTimeout(t);
  }, [adjustmentSuccess]);

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
        floatingActions
        description="Full ledger of stock changes at this branch — sales, receipts, transfers, adjustments, and returns."
        actions={
          canWrite ? (
            <ActionButton
              icon={<IconPlus size={16} />}
              tooltip="Post a stock quantity correction"
              onClick={() => setAdjustmentOpen(true)}
            >
              New adjustment
            </ActionButton>
          ) : null
        }
      />

      {adjustmentSuccess && <Alert variant="success">{adjustmentSuccess}</Alert>}

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
                options={[
                  ...new Map(
                    [...selectedStock.rows, ...stock.rows].map((row) => [
                      row.productId,
                      {
                        value: row.productId,
                        label: `${row.product.sku} — ${row.product.name}`,
                      },
                    ]),
                  ).values(),
                ]}
                searchable
                searchPlaceholder="Search by product or SKU…"
                onSearchChange={setProductSearch}
                onChange={setProductFilter}
                disabled={stock.loading && selectedStock.loading}
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
                <RoleButton
                  permissions={["inventory.manage"]}
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    color: "var(--pc-primary)",
                    cursor: "pointer",
                    font: "inherit",
                    textDecoration: "underline",
                  }}
                  onClick={() => setAdjustmentOpen(true)}
                >
                  Post a new adjustment
                </RoleButton>{" "}
                to see it appear here.
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

      <AdjustmentModal
        open={adjustmentOpen}
        onClose={() => setAdjustmentOpen(false)}
        initialProductId={productId ?? ""}
        onSuccess={(message) => {
          setAdjustmentSuccess(message);
          void movements.reload();
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

