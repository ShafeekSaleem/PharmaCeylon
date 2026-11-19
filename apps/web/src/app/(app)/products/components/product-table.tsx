"use client";

import { useMemo } from "react";
import { IconCheck, IconPackage, IconPlus } from "@/components/icons";
import {
  DataTable,
  rowMenuColumn,
  type Column,
  type SortDir,
} from "@/components/ui";
import { PAGE_SIZE, REFERENCE_HIDDEN_COLUMNS } from "../constants";
import css from "../products.module.css";
import type { ColumnKey, Product, ProductScope } from "../types";
import {
  distinctBrand,
  distinctGeneric,
  distinctSku,
  scheduleBadge,
  stockCell,
} from "../utils/list-cells";
import cells from "./product-table.module.css";

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
  /** Which tab the table is showing — changes the empty state and the actions column. */
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

/**
 * The Products list on the shared list pattern (#205, Products):
 * - generic name on a muted second line under the product name;
 * - one schedule badge (OTC / Rx · II B / Controlled · III) in place of the Rx tag, the
 *   "Prescription required" chip and the plain Schedule column;
 * - Brand left blank when it only repeats the name, SKU when it only repeats the reg. no.;
 * - no placeholder thumbnail column;
 * - stock as a number with a short note, only zero and low coloured;
 * - Status shows only Inactive;
 * - one row-actions menu, Delete behind a divider and never beside Edit.
 */
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
        key: "name",
        header: "Product",
        sortable: true,
        getValue: (row) => row.name,
        render: (row) => {
          // Generic name on the muted second line. When the Brand column is hidden, a brand
          // that differs from the name joins that line rather than disappearing.
          const generic = distinctGeneric(row);
          const brand = !visibleColumns.has("brandName")
            ? distinctBrand(row)
            : null;
          const second = [generic, brand].filter(Boolean).join(" · ");
          return (
            <div className={cells.nameCell}>
              <span className={cells.nameLine}>
                <span className={cells.name}>{row.name}</span>
                {(row.sameNameCount ?? 1) > 1 ? (
                  <span
                    className={cells.quietTag}
                    title={`${row.sameNameCount} registrations share this display name`}
                  >
                    {row.sameNameCount} regs
                  </span>
                ) : null}
                {/* Only ever present when a search term was given. Words, not a colour —
                    "why did this come back" has to be readable, not decoded. */}
                {row.matchType && row.matchType !== "partial" ? (
                  <span className={cells.quietTag}>
                    {MATCH_LABELS[row.matchType]}
                  </span>
                ) : null}
              </span>
              {second ? (
                <span className={cells.secondLine}>{second}</span>
              ) : null}
            </div>
          );
        },
      },
      {
        key: "sku",
        header: "SKU",
        sortable: true,
        width: "96px",
        getValue: (row) => row.sku,
        // Register imports use the registration number as the SKU. Printing it twice on every
        // row is noise, so while Reg. no. is showing that copy is the one kept.
        render: (row) => {
          const sku = visibleColumns.has("registrationNo")
            ? distinctSku(row)
            : row.sku;
          return sku ? <>{sku}</> : null;
        },
      },
      {
        key: "brandName",
        header: "Brand",
        width: "120px",
        sortable: true,
        getValue: (row) => row.brandName ?? "",
        render: (row) => <>{distinctBrand(row) ?? ""}</>,
      },
      {
        key: "dosageForm",
        header: "Form / Strength",
        width: "160px",
        getValue: (row) => row.dosageForm ?? "",
        // One line, cut with an ellipsis; the full wording is in the tooltip.
        render: (row) => {
          const text = [row.dosageForm, row.strength].filter(Boolean).join(" · ");
          return text ? <span title={text}>{text}</span> : null;
        },
      },
      {
        key: "manufacturer",
        header: "Manufacturer",
        width: "150px",
        getValue: (row) => row.manufacturer ?? "",
        render: (row) => <>{row.manufacturer ?? ""}</>,
      },
      {
        key: "unit",
        header: "Unit",
        width: "70px",
        getValue: (row) => row.unit ?? "",
        render: (row) => <>{row.unit ?? ""}</>,
      },
      {
        key: "registrationNo",
        header: "Reg. no.",
        width: "100px",
        sortable: true,
        getValue: (row) => row.registrationNo ?? "",
        render: (row) => <>{row.registrationNo ?? ""}</>,
      },
      {
        key: "schedule",
        header: "Schedule",
        width: "132px",
        sortable: true,
        getValue: (row) => row.schedule ?? "",
        render: (row) => <ScheduleBadge row={row} />,
      },
      {
        key: "stock",
        header: "Stock",
        width: "128px",
        render: (row) => <StockCell row={row} />,
      },
      {
        key: "reorderLevel",
        header: "Reorder level",
        align: "right",
        width: "104px",
        sortable: true,
        getValue: (row) => row.reorderLevel,
        render: (row) => <>{row.reorderLevel}</>,
      },
      {
        key: "status",
        header: "Status",
        width: "92px",
        // Active is the normal state, so it is not shown; only Inactive is (#205 rule 1).
        render: (row) =>
          row.isActive ? null : (
            <span className={cells.inactive}>Inactive</span>
          ),
      },
      scope === "reference"
        ? {
            key: "actions",
            header: <span className={cells.srOnlyHeader}>Actions</span>,
            mobileLabel: "",
            width: "132px",
            align: "right",
            // A reference row is the regulator's record, not the shop's. Edit and delete on
            // one would be editing the register, so the only action offered is the one that
            // makes sense: start selling it. (Deleting a claimed reference row is also refused
            // by the API's foreign key, which would otherwise strand the link history.)
            render: (row) => {
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
                    // The row itself opens the detail page; the button must not do both.
                    e.stopPropagation();
                    onAddReference(row);
                  }}
                >
                  <IconPlus size={12} aria-hidden />
                  {busy ? "Adding…" : "Add"}
                </button>
              );
            },
          }
        : rowMenuColumn<Product>(
            (row) =>
              canWrite
                ? [
                    { label: "Edit product", onClick: () => onEdit(row) },
                    ...(canDelete
                      ? [
                          {
                            label: "Delete product",
                            danger: true,
                            onClick: () => onDelete(row),
                          },
                        ]
                      : []),
                  ]
                : [],
            (row) => row.name,
          ),
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
    () =>
      allColumnDefs.filter(
        (col) =>
          visibleColumns.has(col.key as ColumnKey) &&
          !(
            scope === "reference" &&
            REFERENCE_HIDDEN_COLUMNS.has(col.key as ColumnKey)
          ),
      ),
    [allColumnDefs, scope, visibleColumns],
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
      variant="list"
      fixedLayout
      minTableWidth="1180px"
      emptyTitle={
        scope === "reference"
          ? "No reference products found"
          : "No products yet"
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

/** One badge for how the product may be sold: OTC, Rx · II B, Controlled · III. */
export function ScheduleBadge({
  row,
}: {
  row: Pick<Product, "isControlled" | "requiresPrescription" | "schedule">;
}) {
  const info = scheduleBadge(row);
  const tone =
    info.kind === "controlled"
      ? cells.scheduleControlled
      : info.kind === "rx"
        ? cells.scheduleRx
        : cells.scheduleOtc;
  return (
    <span className={`${cells.schedule} ${tone}`} title={info.description}>
      {info.label}
    </span>
  );
}

/** Stock as a number with a short note. Only zero and low are coloured, and both say so in words. */
export function StockCell({
  row,
}: {
  row: Pick<
    Product,
    "qtyOnHand" | "stockStatus" | "reorderLevel" | "reorderGap"
  >;
}) {
  const info = stockCell(row);
  if (info.qty === null) {
    return (
      <span className={cells.muted} title={info.description}>
        —
      </span>
    );
  }
  const tone =
    info.tone === "out"
      ? cells.stockOut
      : info.tone === "low"
        ? cells.stockLow
        : "";
  return (
    <span
      className={`${cells.stock}${tone ? ` ${tone}` : ""}`}
      title={info.description}
    >
      <span className={cells.stockQty}>{info.qty.toLocaleString()}</span>
      {info.note ? <span className={cells.stockNote}>{info.note}</span> : null}
    </span>
  );
}
