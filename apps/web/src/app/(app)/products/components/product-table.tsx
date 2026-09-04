"use client";

import { useMemo } from "react";
import { IconAlertTriangle, IconCheck, IconPackage, IconPlus } from "@/components/icons";
import { DataTable, StatusBadge, type Column, type SortDir } from "@/components/ui";
import { PAGE_SIZE } from "../constants";
import css from "../products.module.css";
import type { ColumnKey, Product, ProductScope } from "../types";
import { ProductActions } from "./product-actions";
import { ProductStockBadge } from "./product-stock-badge";
import { ProductThumb } from "./product-thumb";

/** Search Catalog's vocabulary, kept verbatim so the merged screen reads the same. */
const MATCH_LABELS: Record<string, string> = {
  exact: "Exact match",
  generic: "Generic match",
  alias: "Alias match",
  partial: "Partial match",
};

type ProductTableProps = {
  products: Product[];
  total: number;
  loading: boolean;
  page: number;
  sortBy: string;
  sortDir: SortDir;
  visibleColumns: Set<ColumnKey>;
  canWrite: boolean;
  canDelete?: boolean;
  /** Which tab the table is showing — changes the empty state and the Status column. */
  scope: ProductScope;
  selectedIds?: ReadonlySet<string>;
  onSelectionChange?: (ids: Set<string>) => void;
  onPageChange: (page: number) => void;
  onSort: (key: string, dir: SortDir | null) => void;
  onRowClick: (row: Product) => void;
  onEdit: (p: Product) => void;
  onDelete: (p: Product) => void;
  /** Reference scope only: promote one register row into the pharmacy's range. */
  onAddReference?: (p: Product) => void;
  /** Ids added in this session, so the row reads "In my products" before the list refetches. */
  addedReferenceIds?: ReadonlySet<string>;
  /** The row currently being added, for its pending label. */
  addingReferenceId?: string | null;
};

export function ProductTable({
  products,
  total,
  loading,
  page,
  sortBy,
  sortDir,
  visibleColumns,
  canWrite,
  canDelete = true,
  scope,
  selectedIds,
  onSelectionChange,
  onPageChange,
  onSort,
  onRowClick,
  onEdit,
  onDelete,
  onAddReference,
  addedReferenceIds,
  addingReferenceId,
}: ProductTableProps) {
  const allColumnDefs: Column<Product>[] = useMemo(
    () => [
      {
        key: "image",
        header: "",
        width: "48px",
        render: (row) => <ProductThumb row={row} />,
      },
      {
        key: "name",
        header: "Product",
        sortable: true,
        getValue: (row) => row.name,
        render: (row) => (
          <div className={css.productCell}>
            {!visibleColumns.has("image") ? <ProductThumb row={row} /> : null}
            <div className={css.nameCell}>
              <span className={css.productName}>
                {row.name}
                {(row.sameNameCount ?? 1) > 1 ? (
                  <span
                    className={css.dupNameBadge}
                    title={`${row.sameNameCount} registrations share this display name`}
                  >
                    {row.sameNameCount} regs
                  </span>
                ) : null}
              </span>
              {row.brandName && !visibleColumns.has("brandName") ? (
                <span className={css.brandUnderTitle}>{row.brandName}</span>
              ) : null}
              {row.registrationNo && !visibleColumns.has("registrationNo") ? (
                <span className={css.regNoHint}>Reg. {row.registrationNo}</span>
              ) : null}
              {row.genericName && row.genericName !== row.name ? (
                <span className={css.genericName}>{row.genericName}</span>
              ) : null}
              <span className={css.tagRow}>
                {/* Only ever present when a search term was given. Words, not a colour —
                    "why did this come back" has to be readable, not decoded. */}
                {row.matchType && row.matchType !== "partial" && (
                  <span className={css.matchChip}>{MATCH_LABELS[row.matchType]}</span>
                )}
                {(row.requiresPrescription || row.isControlled) && (
                  <span className={css.rxTag}>Rx</span>
                )}
                {row.schedule && !visibleColumns.has("schedule") ? (
                  <span className={css.metaChip}>Schedule {row.schedule}</span>
                ) : null}
                {/* `row.categories` is COMMERCIAL-only (server-scoped) — no name-based
                    filtering needed to keep Schedule/Dosage Form names out of this chip. */}
                {(row.categories ?? [])
                  .filter((c) => !c.name.includes("—") && c.name.length < 28)
                  .slice(0, 1)
                  .map((c) => (
                    <span key={c.id} className={css.metaChip}>
                      {c.name}
                    </span>
                  ))}
                {(row.tags ?? [])
                  .filter((t) =>
                    /unbranded|prescription required|controlled medicine/i.test(t.name),
                  )
                  .slice(0, 1)
                  .map((t) => (
                    <span key={t.id} className={css.metaChip}>
                      {t.name.includes("Unbranded") ? "Unbranded" : t.name}
                    </span>
                  ))}
              </span>
            </div>
          </div>
        ),
      },
      {
        key: "sku",
        header: "SKU",
        sortable: true,
        width: "110px",
        getValue: (row) => row.sku,
      },
      {
        key: "brandName",
        header: "Brand",
        sortable: true,
        getValue: (row) => row.brandName ?? "",
        render: (row) => <>{row.brandName ?? "—"}</>,
      },
      {
        key: "dosageForm",
        header: "Form / Strength",
        getValue: (row) => row.dosageForm ?? "",
        render: (row) => (
          <>
            {row.dosageForm ?? "—"}
            {row.strength ? ` · ${row.strength}` : ""}
          </>
        ),
      },
      {
        key: "manufacturer",
        header: "Manufacturer",
        getValue: (row) => row.manufacturer ?? "",
        render: (row) => <>{row.manufacturer ?? "—"}</>,
      },
      {
        key: "unit",
        header: "Unit",
        width: "80px",
        getValue: (row) => row.unit ?? "",
        render: (row) => <>{row.unit ?? "—"}</>,
      },
      {
        key: "registrationNo",
        header: "Reg. no.",
        width: "110px",
        sortable: true,
        getValue: (row) => row.registrationNo ?? "",
        render: (row) => <>{row.registrationNo ?? "—"}</>,
      },
      {
        key: "schedule",
        header: "Schedule",
        width: "90px",
        sortable: true,
        getValue: (row) => row.schedule ?? "",
        render: (row) => <>{row.schedule ?? "—"}</>,
      },
      {
        key: "stock",
        header: "Stock",
        align: "left",
        width: "150px",
        // A reference record isn't "out of stock" — the pharmacy never carried it. A red
        // 0-units badge on every row would read as a shelf full of problems.
        render: (row) =>
          scope === "reference" ? (
            <span className={css.notStockedCell}>Not stocked</span>
          ) : (
            <ProductStockBadge
              qtyOnHand={row.qtyOnHand}
              stockStatus={row.stockStatus}
              reorderGap={row.reorderGap}
              reorderLevel={row.reorderLevel}
            />
          ),
      },
      {
        key: "reorderLevel",
        header: "Reorder Lvl",
        align: "right",
        width: "100px",
        sortable: true,
        getValue: (row) => row.reorderLevel,
        render: (row) => <>{row.reorderLevel}</>,
      },
      {
        key: "status",
        header: "Status",
        width: "132px",
        render: (row) => (
          <div className={css.statusCell}>
            {/* On the reference tab every row is REFERENCE, so an "active/inactive" badge
                would be answering a question nobody asked — say what the row actually is. */}
            {scope === "reference" ? (
              <span className={css.referenceTag}>Reference</span>
            ) : (
              <StatusBadge status={row.isActive ? "active" : "inactive"} dot />
            )}
            {row.isControlled ? (
              <span className={css.controlledTag}>
                <IconAlertTriangle size={11} />
                Ctrl
              </span>
            ) : null}
          </div>
        ),
      },
      {
        key: "actions",
        header: "Actions",
        width: scope === "reference" ? "132px" : "72px",
        align: "right",
        // A reference row is the regulator's record, not the shop's. Edit and delete on one
        // would be editing the register, so the only action offered is the one that makes
        // sense: start selling it. (Deleting a claimed reference row is also refused by the
        // API's new foreign key, which would otherwise strand the link history.)
        render: (row) => {
          if (scope === "reference") {
            if (!canWrite || !onAddReference) return null;
            const added = addedReferenceIds?.has(row.id) ?? false;
            if (added) {
              return (
                <span className={css.referenceAddedChip}>
                  <IconCheck size={11} aria-hidden />
                  In my products
                </span>
              );
            }
            const busy = addingReferenceId === row.id;
            return (
              <button
                type="button"
                className={css.referenceAddBtn}
                disabled={busy}
                aria-label={`Add ${row.name} to my products`}
                onClick={(e) => {
                  // The row itself opens the detail panel; the button must not do both.
                  e.stopPropagation();
                  onAddReference(row);
                }}
              >
                <IconPlus size={12} aria-hidden />
                {busy ? "Adding…" : "Add"}
              </button>
            );
          }
          return canWrite ? (
            <ProductActions row={row} canDelete={canDelete} onEdit={onEdit} onDelete={onDelete} />
          ) : null;
        },
      },
    ],
    [
      addedReferenceIds,
      addingReferenceId,
      canDelete,
      canWrite,
      onAddReference,
      onDelete,
      onEdit,
      scope,
      visibleColumns,
    ],
  );

  const columns = useMemo(
    () => allColumnDefs.filter((col) => visibleColumns.has(col.key as ColumnKey)),
    [allColumnDefs, visibleColumns],
  );

  return (
    <DataTable<Product>
      columns={columns}
      data={products}
      rowKey={(r) => r.id}
      loading={loading}
      page={page}
      pageSize={PAGE_SIZE}
      total={total}
      onPageChange={onPageChange}
      sortKey={sortBy}
      sortDir={sortDir}
      onSort={onSort}
      onRowClick={onRowClick}
      selectedKeys={selectedIds}
      onSelectionChange={onSelectionChange}
      compact
      emptyTitle={
        scope === "reference" ? "No reference products found" : "No products yet"
      }
      emptyDescription={
        scope === "reference"
          ? "Import the NMRA register to search every medicine registered in Sri Lanka, then add the ones you sell."
          : "Add a product, or open the Reference catalog tab to pull one in from the register."
      }
      emptyIcon={<IconPackage size={42} />}
    />
  );
}
